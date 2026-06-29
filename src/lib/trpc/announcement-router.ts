import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { prisma } from "@/lib/prisma"
import { router, protectedProcedure, getMember, assertOrg } from "./server"
import { deleteFromR2 } from "@/lib/r2"

export const announcementRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        teamId: z.string().optional(),
        scope: z.enum(["org", "team"]).optional(),
        search: z.string().optional(),
        cursor: z.number().optional(),
        take: z.number().optional().default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isOrgAdmin = member.role === "owner" || member.role === "admin"

      const userTeamIds = isOrgAdmin
        ? undefined
        : (
            await prisma.teamMember.findMany({
              where: { userId: ctx.session.user.id },
              select: { teamId: true },
            })
          ).map((tm) => tm.teamId)

      const where: Record<string, unknown> = {
        organizationId: input.organizationId,
      }

      if (input.search) {
        where.title = { contains: input.search, mode: "insensitive" }
      }

      // scope="org": only org-wide announcements
      if (input.scope === "org") {
        where.teamId = null
      } else if (input.scope === "team") {
        if (isOrgAdmin) {
          where.teamId = { not: null }
        } else if (userTeamIds && userTeamIds.length > 0) {
          where.teamId = { in: userTeamIds }
        } else {
          where.id = "none"
        }
      } else if (input.teamId) {
        if (!isOrgAdmin && !(userTeamIds ?? []).includes(input.teamId)) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
        where.teamId = input.teamId
      } else if (!isOrgAdmin && userTeamIds) {
        where.OR = [{ teamId: null }, { teamId: { in: userTeamIds } }]
      }

      const [announcements, total] = await Promise.all([
        prisma.announcement.findMany({
          where,
          include: {
            author: { select: { id: true, name: true, image: true } },
            attachments: {
              where: { isThumbnail: true },
              select: { url: true },
              take: 1,
            },
            _count: { select: { comments: true, likes: true } },
          },
          orderBy:
            input.scope === "team"
              ? [{ createdAt: "desc" }]
              : [{ pinned: "desc" }, { createdAt: "desc" }],
          skip: input.cursor ?? 0,
          take: input.take + 1,
        }),
        prisma.announcement.count({ where }),
      ])

      const hasMore = announcements.length > input.take
      if (hasMore) announcements.pop()

      // Check if current user liked each announcement
      const likedSet = new Set(
        (
          await prisma.announcementLike.findMany({
            where: {
              userId: ctx.session.user.id,
              announcementId: { in: announcements.map((a) => a.id) },
            },
            select: { announcementId: true },
          })
        ).map((l) => l.announcementId),
      )

      return {
        announcements: announcements.map(({ attachments: _atts, ...a }) => ({
          ...a,
          liked: likedSet.has(a.id),
          thumbnailUrl: _atts?.[0]?.url ?? undefined,
        })),
        total,
        hasMore,
      }
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string(), organizationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const announcement = await prisma.announcement.findUnique({
        where: { id: input.id },
        include: {
          author: { select: { id: true, name: true, image: true } },
          team: { select: { id: true, name: true } },
          attachments: {
            select: {
              id: true,
              name: true,
              url: true,
              type: true,
              size: true,
              isThumbnail: true,
            },
          },
          links: { select: { id: true, url: true, title: true } },
          comments: {
            include: {
              author: { select: { id: true, name: true, image: true } },
              replies: {
                include: {
                  author: { select: { id: true, name: true, image: true } },
                },
                orderBy: { createdAt: "asc" },
              },
            },
            where: { parentId: null },
            orderBy: { createdAt: "asc" },
          },
          _count: { select: { likes: true } },
        },
      })
      if (!announcement) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(announcement.organizationId, input.organizationId)

      const liked = !!(await prisma.announcementLike.findUnique({
        where: {
          announcementId_userId: {
            announcementId: input.id,
            userId: ctx.session.user.id,
          },
        },
      }))

      return { announcement: { ...announcement, liked } }
    }),

  create: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        title: z.string().min(1, "Title is required."),
        content: z.string().min(1, "Content is required."),
        teamId: z.string().optional(),
        enableComments: z.boolean().optional(),
        enableLikes: z.boolean().optional(),
        pinned: z.boolean().optional(),
        links: z
          .array(z.object({ url: z.string(), title: z.string() }))
          .optional(),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              url: z.string(),
              type: z.string(),
              size: z.number(),
              isThumbnail: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      // Team must belong to the same org (prevents cross-org team references).
      if (input.teamId) {
        const teamOrg = await prisma.team.findUnique({
          where: { id: input.teamId },
          select: { organizationId: true },
        })
        if (!teamOrg) throw new TRPCError({ code: "NOT_FOUND" })
        assertOrg(teamOrg.organizationId, input.organizationId)
      }

      const isOrgAdmin = member.role === "owner" || member.role === "admin"

      // Team-scoped: must be team leader, co-leader, or org admin
      if (input.teamId && !isOrgAdmin) {
        const team = await prisma.team.findUnique({
          where: { id: input.teamId },
        })
        const isCoLeader = await prisma.teamMember.findFirst({
          where: {
            teamId: input.teamId,
            userId: ctx.session.user.id,
            role: "co-leader",
          },
        })
        if (!team || (team.leaderId !== member.id && !isCoLeader)) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      }

      // Org-wide: only org admin
      if (!input.teamId && !isOrgAdmin) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      const announcement = await prisma.announcement.create({
        data: {
          title: input.title,
          content: input.content,
          teamId: input.teamId ?? null,
          enableComments: input.enableComments ?? true,
          enableLikes: input.enableLikes ?? true,
          pinned: input.pinned ?? false,
          organizationId: input.organizationId,
          authorId: ctx.session.user.id,
          links: input.links?.length
            ? {
                create: input.links,
              }
            : undefined,
          attachments: input.attachments?.length
            ? {
                create: input.attachments.map((a) => ({
                  name: a.name,
                  url: a.url,
                  type: a.type,
                  size: a.size,
                  isThumbnail: a.isThumbnail ?? false,
                })),
              }
            : undefined,
        },
        include: {
          author: { select: { id: true, name: true, image: true } },
          links: true,
          attachments: true,
          _count: { select: { comments: true, likes: true } },
        },
      })

      // Create notifications
      const recipientIds = input.teamId
        ? (
            await prisma.teamMember.findMany({
              where: { teamId: input.teamId },
              select: { userId: true },
            })
          ).map((tm) => tm.userId)
        : (
            await prisma.member.findMany({
              where: { organizationId: input.organizationId },
              select: { userId: true },
            })
          ).map((m) => m.userId)

      const notifyIds = recipientIds.filter((id) => id !== ctx.session.user.id)
      if (notifyIds.length > 0) {
        await prisma.notification.createMany({
          data: notifyIds.map((userId) => ({
            type: "announcement",
            title: `New announcement: ${input.title}`,
            organizationId: input.organizationId,
            userId,
            announcementId: announcement.id,
          })),
        })
      }

      return { announcement: { ...announcement, liked: false } }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        organizationId: z.string(),
        title: z.string().min(1).optional(),
        content: z.string().min(1).optional(),
        enableComments: z.boolean().optional(),
        enableLikes: z.boolean().optional(),
        pinned: z.boolean().optional(),
        links: z
          .array(z.object({ url: z.string(), title: z.string() }))
          .optional(),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              url: z.string(),
              type: z.string(),
              size: z.number(),
              isThumbnail: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const existing = await prisma.announcement.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(existing.organizationId, input.organizationId)

      const isOrgAdmin = member.role === "owner" || member.role === "admin"
      const isAuthor = existing.authorId === ctx.session.user.id

      if (!isOrgAdmin && !isAuthor) {
        const isCoLeader =
          existing.teamId &&
          (await prisma.teamMember.findFirst({
            where: {
              teamId: existing.teamId,
              userId: ctx.session.user.id,
              role: "co-leader",
            },
          }))
        if (!isCoLeader) throw new TRPCError({ code: "FORBIDDEN" })
      }

      const {
        id,
        organizationId: _orgId,
        links: _links,
        attachments: _newAttachments,
        ...data
      } = input

      const updateData: Record<string, unknown> = { ...data }

      if (_links) {
        updateData.links = { deleteMany: {}, create: _links }
      }

      if (_newAttachments) {
        // Delete removed attachments from R2 (compare URLs)
        const oldAtts = await prisma.announcementAttachment.findMany({
          where: { announcementId: input.id },
          select: { url: true },
        })
        const newUrls = new Set(_newAttachments.map((a) => a.url))
        const removed = oldAtts.filter((a) => !newUrls.has(a.url))
        for (const att of removed) await deleteFromR2(att.url)
        updateData.attachments = { deleteMany: {}, create: _newAttachments }
      }

      const announcement = await prisma.announcement.update({
        where: { id: input.id },
        data: updateData,
        include: {
          author: { select: { id: true, name: true, image: true } },
          _count: { select: { comments: true, likes: true } },
        },
      })

      const liked = !!(await prisma.announcementLike.findUnique({
        where: {
          announcementId_userId: {
            announcementId: input.id,
            userId: ctx.session.user.id,
          },
        },
      }))

      return { announcement: { ...announcement, liked } }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string(), organizationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const existing = await prisma.announcement.findUnique({
        where: { id: input.id },
        include: { attachments: { select: { url: true } } },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(existing.organizationId, input.organizationId)

      const isOrgAdmin = member.role === "owner" || member.role === "admin"
      const isAuthor = existing.authorId === ctx.session.user.id

      if (!isOrgAdmin && !isAuthor) {
        const isCoLeader =
          existing.teamId &&
          (await prisma.teamMember.findFirst({
            where: {
              teamId: existing.teamId,
              userId: ctx.session.user.id,
              role: "co-leader",
            },
          }))
        if (!isCoLeader) throw new TRPCError({ code: "FORBIDDEN" })
      }

      // Delete attachments from R2
      for (const att of existing.attachments) {
        await deleteFromR2(att.url)
      }

      await prisma.announcement.delete({ where: { id: input.id } })
      return { success: true }
    }),

  deleteAttachment: protectedProcedure
    .input(z.object({ id: z.string(), organizationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const attachment = await prisma.announcementAttachment.findUnique({
        where: { id: input.id },
        include: {
          announcement: { select: { authorId: true, organizationId: true } },
        },
      })
      if (!attachment) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(attachment.announcement.organizationId, input.organizationId)

      const isOrgAdmin = member.role === "owner" || member.role === "admin"
      const isAuthor = attachment.announcement.authorId === ctx.session.user.id
      if (!isOrgAdmin && !isAuthor) throw new TRPCError({ code: "FORBIDDEN" })

      await deleteFromR2(attachment.url)
      await prisma.announcementAttachment.delete({ where: { id: input.id } })
      return { success: true }
    }),

  // ── Comments ──

  commentCreate: protectedProcedure
    .input(
      z.object({
        announcementId: z.string(),
        organizationId: z.string(),
        content: z.string().min(1, "Comment is required."),
        parentId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const announcement = await prisma.announcement.findUnique({
        where: { id: input.announcementId },
        select: {
          enableComments: true,
          authorId: true,
          title: true,
          organizationId: true,
        },
      })
      if (!announcement) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(announcement.organizationId, input.organizationId)
      if (!announcement.enableComments)
        throw new TRPCError({ code: "FORBIDDEN" })

      const comment = await prisma.announcementComment.create({
        data: {
          content: input.content,
          announcementId: input.announcementId,
          authorId: ctx.session.user.id,
          parentId: input.parentId ?? null,
        },
        include: {
          author: { select: { id: true, name: true, image: true } },
        },
      })

      // Notify announcement author (only if commenter is not the author)
      if (announcement.authorId !== ctx.session.user.id) {
        await prisma.notification.create({
          data: {
            type: "announcement_comment",
            title:
              comment.author.name +
              ' commented on "' +
              announcement.title +
              '"',
            body: input.content.slice(0, 120),
            organizationId: input.organizationId,
            userId: announcement.authorId,
            announcementId: input.announcementId,
          },
        })
      }

      // For replies: notify parent comment author
      if (input.parentId) {
        const parentComment = await prisma.announcementComment.findUnique({
          where: { id: input.parentId },
          select: { authorId: true },
        })
        if (parentComment && parentComment.authorId !== ctx.session.user.id) {
          await prisma.notification.create({
            data: {
              type: "announcement_comment",
              title: `${comment.author.name} replied to your comment`,
              body: input.content.slice(0, 120),
              organizationId: input.organizationId,
              userId: parentComment.authorId,
              announcementId: input.announcementId,
            },
          })
        }
      }

      return { comment }
    }),

  commentDelete: protectedProcedure
    .input(z.object({ id: z.string(), organizationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const existing = await prisma.announcementComment.findUnique({
        where: { id: input.id },
        include: {
          announcement: { select: { authorId: true, organizationId: true } },
        },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(existing.announcement.organizationId, input.organizationId)

      const isOrgAdmin = member.role === "owner" || member.role === "admin"
      const isCommentAuthor = existing.authorId === ctx.session.user.id
      const isAnnouncementAuthor =
        existing.announcement.authorId === ctx.session.user.id

      if (!isOrgAdmin && !isCommentAuthor && !isAnnouncementAuthor) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      await prisma.announcementComment.delete({ where: { id: input.id } })
      return { success: true }
    }),

  // ── Likes ──

  likeToggle: protectedProcedure
    .input(z.object({ announcementId: z.string(), organizationId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const announcement = await prisma.announcement.findUnique({
        where: { id: input.announcementId },
        select: { enableLikes: true, organizationId: true },
      })
      if (!announcement) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(announcement.organizationId, input.organizationId)
      if (!announcement.enableLikes) throw new TRPCError({ code: "FORBIDDEN" })

      const existing = await prisma.announcementLike.findUnique({
        where: {
          announcementId_userId: {
            announcementId: input.announcementId,
            userId: ctx.session.user.id,
          },
        },
      })

      if (existing) {
        await prisma.announcementLike.delete({ where: { id: existing.id } })
        return { liked: false }
      }

      await prisma.announcementLike.create({
        data: {
          announcementId: input.announcementId,
          userId: ctx.session.user.id,
        },
      })
      return { liked: true }
    }),
})
