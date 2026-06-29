import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { prisma } from "@/lib/prisma"
import { router, protectedProcedure, getMember } from "./server"

export const memberRouter = router({
  listByUserIds: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        userIds: z.array(z.string()),
      }),
    )
    .query(async ({ ctx, input }) => {
      const caller = await getMember(input.organizationId, ctx.session.user.id)
      if (!caller) throw new TRPCError({ code: "FORBIDDEN" })

      const members = await prisma.member.findMany({
        where: {
          organizationId: input.organizationId,
          userId: { in: input.userIds },
        },
      })
      return { members }
    }),

  getMyRole: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      if (member.role === "owner" || member.role === "admin") {
        return { role: member.role as "owner" | "admin" }
      }

      return { role: "member" as const }
    }),

  updateOrgMemberStatus: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        userId: z.string(),
        status: z.enum(["active", "inactive"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const caller = await getMember(input.organizationId, ctx.session.user.id)
      if (!caller || (caller.role !== "owner" && caller.role !== "admin")) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      const target = await getMember(input.organizationId, input.userId)
      if (!target)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Member not found",
        })
      if (target.role === "owner" || target.role === "admin") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot change status of org owners/admins",
        })
      }

      await prisma.member.update({
        where: { id: target.id },
        data: { status: input.status },
      })

      return { success: true }
    }),

  listWithStatus: protectedProcedure
    .input(z.object({ organizationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const caller = await getMember(input.organizationId, ctx.session.user.id)
      if (!caller) throw new TRPCError({ code: "FORBIDDEN" })

      const members = await prisma.member.findMany({
        where: { organizationId: input.organizationId },
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
          user: { select: { id: true, name: true, email: true, image: true } },
        },
        orderBy: { createdAt: "asc" },
      })

      return { members }
    }),

  listActiveOrganizations: protectedProcedure.query(async ({ ctx }) => {
    const memberships = await prisma.member.findMany({
      where: {
        userId: ctx.session.user.id,
        status: "active",
        OR: [
          { role: { in: ["owner", "admin"] } },
          {
            organization: {
              teams: {
                some: {
                  members: {
                    some: {
                      userId: ctx.session.user.id,
                      status: "active",
                    },
                  },
                },
              },
            },
          },
        ],
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            websiteUrl: true,
            department: true,
            teamSize: true,
          },
        },
      },
    })
    const organizations = memberships.map((m) => m.organization)
    return { organizations }
  }),
})
