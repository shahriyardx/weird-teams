import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { prisma } from "@/lib/prisma"
import { deleteFromR2 } from "@/lib/r2"
import { router, protectedProcedure, getMember, assertOrg } from "./server"

/** Verifies a team (if provided) belongs to the given org. */
async function assertTeamInOrg(
  teamId: string | undefined,
  organizationId: string,
) {
  if (!teamId) return
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: { organizationId: true },
  })
  if (!team) throw new TRPCError({ code: "NOT_FOUND" })
  assertOrg(team.organizationId, organizationId)
}

export const knowledgeBaseRouter = router({
  // ── Categories ──

  categoryList: protectedProcedure
    .input(
      z.object({ organizationId: z.string(), teamId: z.string().optional() }),
    )
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const where: Record<string, unknown> = {
        organizationId: input.organizationId,
      }
      if (input.teamId) {
        where.teamId = input.teamId
      } else {
        where.teamId = null
      }

      const categories = await prisma.kbCategory.findMany({
        where,
        include: {
          subcategories: {
            orderBy: { name: "asc" },
          },
        },
        orderBy: { name: "asc" },
      })
      return { categories }
    }),

  categoryCreate: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        name: z.string().min(1).max(48),
        teamId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      await assertTeamInOrg(input.teamId, input.organizationId)

      const category = await prisma.kbCategory.create({
        data: {
          name: input.name,
          organizationId: input.organizationId,
          teamId: input.teamId ?? null,
          subcategories: {
            create: {
              name: "Uncategorized",
              organizationId: input.organizationId,
            },
          },
        },
        include: { subcategories: true },
      })
      return { category }
    }),

  categoryUpdate: protectedProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(48) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbCategory.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const category = await prisma.kbCategory.update({
        where: { id: input.id },
        data: { name: input.name },
      })
      return { category }
    }),

  categoryDelete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbCategory.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      await prisma.kbCategory.delete({ where: { id: input.id } })
      return { success: true }
    }),

  // ── Subcategories ──

  subcategoryCreate: protectedProcedure
    .input(
      z.object({ categoryId: z.string(), name: z.string().min(1).max(48) }),
    )
    .mutation(async ({ ctx, input }) => {
      const category = await prisma.kbCategory.findUnique({
        where: { id: input.categoryId },
      })
      if (!category) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        category.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const subcategory = await prisma.kbSubcategory.create({
        data: {
          name: input.name,
          categoryId: input.categoryId,
          organizationId: category.organizationId,
        },
      })
      return { subcategory }
    }),

  subcategoryUpdate: protectedProcedure
    .input(z.object({ id: z.string(), name: z.string().min(1).max(48) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbSubcategory.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const subcategory = await prisma.kbSubcategory.update({
        where: { id: input.id },
        data: { name: input.name },
      })
      return { subcategory }
    }),

  subcategoryDelete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbSubcategory.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      await prisma.kbSubcategory.delete({ where: { id: input.id } })
      return { success: true }
    }),

  // ── Items ──

  itemList: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        categoryId: z.string().optional(),
        subcategoryId: z.string().optional(),
        teamId: z.string().optional(),
        skip: z.number().int().min(0).default(0),
        take: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const where: Record<string, unknown> = {
        organizationId: input.organizationId,
        deletedAt: null,
      }
      if (input.teamId) {
        where.teamId = input.teamId
      } else {
        where.teamId = null
      }
      if (input.subcategoryId) where.subcategoryId = input.subcategoryId
      if (input.categoryId) {
        where.subcategory = { categoryId: input.categoryId }
      }

      const [items, total] = await prisma.$transaction(async (tx) => {
        const data = await tx.kbItem.findMany({
          where,
          include: {
            author: { select: { id: true, name: true, image: true } },
            subcategory: {
              select: {
                id: true,
                name: true,
                categoryId: true,
                category: { select: { id: true, name: true } },
              },
            },
            attachments: {
              select: { id: true, name: true, url: true, type: true },
            },
            links: { select: { id: true, url: true, title: true } },
            _count: { select: { attachments: true, links: true } },
          },
          orderBy: { createdAt: "desc" },
          skip: input.skip,
          take: input.take,
        })
        const count = await tx.kbItem.count({ where })
        return [data, count] as const
      })

      return { items, total }
    }),

  searchItems: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        query: z.string().min(1).max(200),
        teamId: z.string().optional(),
        categoryId: z.string().optional(),
        skip: z.number().int().min(0).default(0),
        take: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const where: Record<string, unknown> = {
        organizationId: input.organizationId,
        deletedAt: null,
        OR: [
          { title: { contains: input.query, mode: "insensitive" } },
          { description: { contains: input.query, mode: "insensitive" } },
        ],
      }
      if (input.teamId) {
        where.teamId = input.teamId
      } else {
        where.teamId = null
      }
      if (input.categoryId) {
        where.subcategory = { categoryId: input.categoryId }
      }

      const [items, total] = await prisma.$transaction(async (tx) => {
        const data = await tx.kbItem.findMany({
          where,
          include: {
            author: { select: { id: true, name: true, image: true } },
            subcategory: {
              select: {
                id: true,
                name: true,
                categoryId: true,
                category: { select: { id: true, name: true } },
              },
            },
            attachments: {
              select: { id: true, name: true, url: true, type: true },
            },
            links: { select: { id: true, url: true, title: true } },
            _count: { select: { attachments: true, links: true } },
          },
          orderBy: { createdAt: "desc" },
          skip: input.skip,
          take: input.take,
        })
        const count = await tx.kbItem.count({ where })
        return [data, count] as const
      })

      return { items, total }
    }),

  itemGet: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const item = await prisma.kbItem.findUnique({
        where: { id: input.id },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
          subcategory: {
            select: {
              id: true,
              name: true,
              category: { select: { id: true, name: true } },
            },
          },
          attachments: {
            select: { id: true, name: true, url: true, type: true, size: true },
          },
          links: { select: { id: true, url: true, title: true } },
        },
      })
      if (!item) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(item.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      let canEdit = false
      let canDelete = false

      if (member.role === "owner" || member.role === "admin") {
        canEdit = true
        canDelete = true
      } else if (item.authorId === ctx.session.user.id) {
        canEdit = true
        canDelete = true
      } else if (item.teamId) {
        const team = await prisma.team.findUnique({
          where: { id: item.teamId },
          select: { leaderId: true },
        })
        if (team?.leaderId === member.id) {
          canEdit = true
          canDelete = true
        }
      }

      return { item, canEdit, canDelete }
    }),

  itemCreate: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        subcategoryId: z.string(),
        title: z.string().min(1).max(200),
        description: z.string().optional(),
        teamId: z.string().optional(),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              url: z.string(),
              type: z.string(),
              size: z.number().int(),
            }),
          )
          .default([]),
        links: z
          .array(
            z.object({
              url: z.string(),
              title: z.string(),
            }),
          )
          .default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const subcategory = await prisma.kbSubcategory.findUnique({
        where: { id: input.subcategoryId },
        select: { organizationId: true },
      })
      if (!subcategory) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(subcategory.organizationId, input.organizationId)

      await assertTeamInOrg(input.teamId, input.organizationId)

      const item = await prisma.kbItem.create({
        data: {
          title: input.title,
          description: input.description,
          subcategoryId: input.subcategoryId,
          organizationId: input.organizationId,
          teamId: input.teamId ?? null,
          authorId: ctx.session.user.id,
          attachments: {
            create: input.attachments,
          },
          links: {
            create: input.links,
          },
        },
        include: {
          author: { select: { id: true, name: true, image: true } },
          subcategory: { select: { id: true, name: true } },
          attachments: true,
          links: true,
        },
      })
      return { item }
    }),

  itemUpdate: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().min(1).max(200).optional(),
        description: z.string().optional(),
        attachments: z
          .array(
            z.object({
              name: z.string(),
              url: z.string(),
              type: z.string(),
              size: z.number().int(),
            }),
          )
          .optional(),
        links: z
          .array(
            z.object({
              url: z.string(),
              title: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbItem.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const changes: Record<string, { old: unknown; new: unknown }> = {}
      if (input.title !== undefined && input.title !== existing.title) {
        changes.title = { old: existing.title, new: input.title }
      }
      if (
        input.description !== undefined &&
        input.description !== existing.description
      ) {
        changes.description = {
          old: existing.description,
          new: input.description,
        }
      }

      if (Object.keys(changes).length > 0) {
        await prisma.kbEditHistory.create({
          data: {
            kbItemId: input.id,
            editorId: ctx.session.user.id,
            changes: JSON.stringify(changes),
          },
        })
      }

      const updateData: Record<string, unknown> = {}
      if (input.title !== undefined) updateData.title = input.title
      if (input.description !== undefined)
        updateData.description = input.description
      if (input.attachments !== undefined) {
        // Delete removed attachments from R2 (compare URLs)
        const oldAtts = await prisma.kbAttachment.findMany({
          where: { kbItemId: input.id },
          select: { url: true },
        })
        const newUrls = new Set(input.attachments.map((a) => a.url))
        const removed = oldAtts.filter((a) => !newUrls.has(a.url))
        for (const att of removed) await deleteFromR2(att.url)
        updateData.attachments = { deleteMany: {}, create: input.attachments }
      }
      if (input.links !== undefined) {
        updateData.links = { deleteMany: {}, create: input.links }
      }

      const item = await prisma.kbItem.update({
        where: { id: input.id },
        data: updateData,
        include: {
          author: { select: { id: true, name: true, image: true } },
          subcategory: { select: { id: true, name: true } },
          attachments: true,
          links: true,
        },
      })
      return { item }
    }),

  itemDelete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbItem.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isPrivileged = member.role === "owner" || member.role === "admin"

      let isTeamLeader = false
      if (!isPrivileged) {
        if (existing.teamId) {
          const ledTeam = await prisma.team.findFirst({
            where: {
              id: existing.teamId,
              leaderId: member.id,
              organizationId: existing.organizationId,
            },
          })
          isTeamLeader = !!ledTeam
        }
      }

      if (
        !isPrivileged &&
        !isTeamLeader &&
        existing.authorId !== ctx.session.user.id
      ) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      await prisma.kbItem.update({
        where: { id: input.id },
        data: { deletedAt: new Date() },
      })
      return { success: true }
    }),

  // ── Comments ──

  commentList: protectedProcedure
    .input(z.object({ kbItemId: z.string() }))
    .query(async ({ ctx, input }) => {
      const item = await prisma.kbItem.findUnique({
        where: { id: input.kbItemId },
      })
      if (!item) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(item.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const comments = await prisma.kbComment.findMany({
        where: { kbItemId: input.kbItemId },
        include: { author: { select: { id: true, name: true, image: true } } },
        orderBy: { createdAt: "asc" },
      })
      return { comments }
    }),

  commentCreate: protectedProcedure
    .input(
      z.object({ kbItemId: z.string(), content: z.string().min(1).max(5000) }),
    )
    .mutation(async ({ ctx, input }) => {
      const item = await prisma.kbItem.findUnique({
        where: { id: input.kbItemId },
      })
      if (!item) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(item.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const comment = await prisma.kbComment.create({
        data: {
          content: input.content,
          kbItemId: input.kbItemId,
          authorId: ctx.session.user.id,
        },
        include: { author: { select: { id: true, name: true, image: true } } },
      })

      // Notify KB item author if commenter is not them
      if (item.authorId !== ctx.session.user.id) {
        await prisma.notification.create({
          data: {
            type: "kb_comment",
            title: `${comment.author.name} commented on "${item.title}"`,
            body:
              input.content.length > 120
                ? `${input.content.slice(0, 120)}…`
                : input.content,
            userId: item.authorId,
            organizationId: item.organizationId,
            kbItemId: item.id,
          },
        })
      }

      return { comment }
    }),

  commentDelete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const comment = await prisma.kbComment.findUnique({
        where: { id: input.id },
        include: { kbItem: { select: { organizationId: true, teamId: true } } },
      })
      if (!comment) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        comment.kbItem.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isPrivileged = member.role === "owner" || member.role === "admin"
      let isTeamLeader = false
      if (!isPrivileged) {
        if (comment.kbItem.teamId) {
          const ledTeam = await prisma.team.findFirst({
            where: {
              id: comment.kbItem.teamId,
              leaderId: member.id,
              organizationId: comment.kbItem.organizationId,
            },
          })
          isTeamLeader = !!ledTeam
        }
      }

      if (
        comment.authorId !== ctx.session.user.id &&
        !isPrivileged &&
        !isTeamLeader
      ) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      await prisma.kbComment.delete({ where: { id: input.id } })
      return { success: true }
    }),

  // ── Edit History ──

  editHistoryList: protectedProcedure
    .input(z.object({ kbItemId: z.string() }))
    .query(async ({ ctx, input }) => {
      const item = await prisma.kbItem.findUnique({
        where: { id: input.kbItemId },
      })
      if (!item) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(item.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const history = await prisma.kbEditHistory.findMany({
        where: { kbItemId: input.kbItemId },
        include: { editor: { select: { id: true, name: true, image: true } } },
        orderBy: { editedAt: "desc" },
        take: 5,
      })
      return { history }
    }),

  // ── Trash ──

  trashList: protectedProcedure
    .input(z.object({ organizationId: z.string(), teamId: z.string() }))
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isPrivileged = member.role === "owner" || member.role === "admin"
      let isTeamLeader = false
      if (!isPrivileged) {
        const ledTeam = await prisma.team.findFirst({
          where: {
            id: input.teamId,
            leaderId: member.id,
            organizationId: input.organizationId,
          },
        })
        isTeamLeader = !!ledTeam
      }
      if (!isPrivileged && !isTeamLeader)
        throw new TRPCError({ code: "FORBIDDEN" })

      const items = await prisma.kbItem.findMany({
        where: {
          organizationId: input.organizationId,
          teamId: input.teamId,
          deletedAt: { not: null },
        },
        include: {
          author: { select: { id: true, name: true, image: true } },
          subcategory: {
            select: {
              id: true,
              name: true,
              category: { select: { id: true, name: true } },
            },
          },
          attachments: {
            select: { id: true, name: true, url: true, type: true },
          },
          links: { select: { id: true, url: true, title: true } },
          _count: { select: { attachments: true, links: true } },
        },
        orderBy: { deletedAt: { sort: "desc", nulls: "last" } },
      })
      return { items }
    }),

  itemRestore: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbItem.findUnique({
        where: { id: input.id },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isPrivileged = member.role === "owner" || member.role === "admin"
      let isTeamLeader = false
      if (!isPrivileged) {
        if (existing.teamId) {
          const ledTeam = await prisma.team.findFirst({
            where: {
              id: existing.teamId,
              leaderId: member.id,
              organizationId: existing.organizationId,
            },
          })
          isTeamLeader = !!ledTeam
        }
      }
      if (!isPrivileged && !isTeamLeader)
        throw new TRPCError({ code: "FORBIDDEN" })

      await prisma.kbItem.update({
        where: { id: input.id },
        data: { deletedAt: null },
      })
      return { success: true }
    }),

  itemPermanentDelete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.kbItem.findUnique({
        where: { id: input.id },
        include: { attachments: { select: { url: true } } },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isPrivileged = member.role === "owner" || member.role === "admin"
      let isTeamLeader = false
      if (!isPrivileged) {
        if (existing.teamId) {
          const ledTeam = await prisma.team.findFirst({
            where: {
              id: existing.teamId,
              leaderId: member.id,
              organizationId: existing.organizationId,
            },
          })
          isTeamLeader = !!ledTeam
        }
      }
      if (!isPrivileged && !isTeamLeader)
        throw new TRPCError({ code: "FORBIDDEN" })

      for (const att of existing.attachments) {
        await deleteFromR2(att.url)
      }

      await prisma.kbItem.delete({ where: { id: input.id } })
      return { success: true }
    }),
})
