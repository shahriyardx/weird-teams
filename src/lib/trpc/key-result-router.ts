import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { prisma } from "@/lib/prisma"
import { router, protectedProcedure, getMember, assertOrg } from "./server"

function calcProgress(currentValue: number, targetValue: number): number {
  if (targetValue <= 0) return 0
  return Math.min(100, Math.round((currentValue / targetValue) * 1000) / 10)
}

function calcStatus(progress: number): string {
  if (progress >= 100) return "achieved"
  if (progress >= 75) return "on_track"
  if (progress >= 50) return "at_risk"
  if (progress > 0) return "behind"
  return "not_started"
}

export const keyResultRouter = router({
  list: protectedProcedure
    .input(z.object({ objectiveId: z.string() }))
    .query(async ({ ctx, input }) => {
      const orgId = ctx.session.session.activeOrganizationId
      if (!orgId) throw new TRPCError({ code: "FORBIDDEN" })

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const objective = await prisma.objective.findUnique({
        where: { id: input.objectiveId },
        select: { organizationId: true },
      })
      if (!objective) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(objective.organizationId, orgId)

      const keyResults = await prisma.keyResult.findMany({
        where: { objectiveId: input.objectiveId },
        include: {
          owner: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
          checkIns: { orderBy: { createdAt: "desc" }, take: 5 },
        },
        orderBy: { sortOrder: "asc" },
      })
      return { keyResults }
    }),

  createOrgLevel: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        targetValue: z.number(),
        maxValue: z.number().nullable().optional(),
        currentValue: z.number().optional(),
        unit: z.string().optional(),
        weight: z.number().optional(),
        objectiveId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.session.session.activeOrganizationId
      if (!orgId) throw new TRPCError({ code: "FORBIDDEN" })

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"
      if (!isAdmin) throw new TRPCError({ code: "FORBIDDEN" })

      const objective = await prisma.objective.findUnique({
        where: { id: input.objectiveId },
      })
      if (!objective || objective.organizationId !== orgId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Objective not found",
        })
      }

      const currentValue = input.currentValue ?? 0
      const krProgress = calcProgress(currentValue, input.targetValue)

      const keyResult = await prisma.keyResult.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          targetValue: input.targetValue,
          maxValue: input.maxValue ?? null,
          currentValue,
          unit: input.unit ?? "number",
          weight: input.weight ?? 1.0,
          progress: krProgress,
          status: calcStatus(krProgress),
          ownerId: member.id,
          objectiveId: input.objectiveId,
          organizationId: orgId,
        },
        include: {
          owner: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
      })

      await recalcObjectiveProgress(objective.id)

      return { keyResult }
    }),

  createTeamLevel: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        targetValue: z.number(),
        maxValue: z.number().nullable().optional(),
        currentValue: z.number().optional(),
        unit: z.string().optional(),
        weight: z.number().optional(),
        objectiveId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.session.session.activeOrganizationId
      if (!orgId) throw new TRPCError({ code: "FORBIDDEN" })

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"

      const objective = await prisma.objective.findUnique({
        where: { id: input.objectiveId },
        include: { cycle: true },
      })
      if (!objective || objective.organizationId !== orgId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Objective not found",
        })
      }

      if (!isAdmin && objective.cycle?.locked) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cycle is locked." })
      }

      if (!isAdmin) {
        if (!objective.teamId) throw new TRPCError({ code: "FORBIDDEN" })

        const isTeamLeader = await prisma.team.findFirst({
          where: {
            id: objective.teamId,
            leaderId: member.id,
            organizationId: orgId,
          },
        })
        if (!isTeamLeader) throw new TRPCError({ code: "FORBIDDEN" })
      }

      const currentValue = input.currentValue ?? 0
      const krProgress = calcProgress(currentValue, input.targetValue)
      const krOwnerId = objective.ownerId ?? member.id

      const keyResult = await prisma.keyResult.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          targetValue: input.targetValue,
          maxValue: input.maxValue ?? null,
          currentValue,
          unit: input.unit ?? "number",
          weight: input.weight ?? 1.0,
          progress: krProgress,
          status: calcStatus(krProgress),
          ownerId: krOwnerId,
          objectiveId: input.objectiveId,
          organizationId: orgId,
        },
        include: {
          owner: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
      })

      await recalcObjectiveProgress(objective.id)

      return { keyResult }
    }),

  createMemberLevel: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        targetValue: z.number(),
        maxValue: z.number().nullable().optional(),
        currentValue: z.number().optional(),
        unit: z.string().optional(),
        weight: z.number().optional(),
        objectiveId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.session.session.activeOrganizationId
      if (!orgId) throw new TRPCError({ code: "FORBIDDEN" })

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"

      const objective = await prisma.objective.findUnique({
        where: { id: input.objectiveId },
        include: { cycle: true },
      })
      if (!objective || objective.organizationId !== orgId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Objective not found",
        })
      }

      if (!isAdmin && objective.cycle?.locked) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cycle is locked." })
      }

      if (!isAdmin) {
        if (!objective.ownerId)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Can only add KRs to member objectives",
          })

        const objOwner = await prisma.member.findUnique({
          where: { id: objective.ownerId },
        })
        if (!objOwner)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Objective owner not found",
          })

        const teamMember = await prisma.teamMember.findFirst({
          where: {
            userId: objOwner.userId,
            teamId: objective.teamId!,
          },
        })
        if (!teamMember) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Can only add KRs to your team's objectives",
          })
        }
      }

      const currentValue = input.currentValue ?? 0
      const krProgress = calcProgress(currentValue, input.targetValue)

      const keyResult = await prisma.keyResult.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          targetValue: input.targetValue,
          maxValue: input.maxValue ?? null,
          currentValue,
          unit: input.unit ?? "number",
          weight: input.weight ?? 1.0,
          progress: krProgress,
          status: calcStatus(krProgress),
          ownerId: objective.ownerId!,
          objectiveId: input.objectiveId,
          organizationId: orgId,
        },
        include: {
          owner: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
      })

      await recalcObjectiveProgress(objective.id)

      return { keyResult }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        targetValue: z.number().optional(),
        maxValue: z.number().nullable().optional(),
        currentValue: z.number().optional(),
        unit: z.string().optional(),
        weight: z.number().optional(),
        ownerId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.keyResult.findUnique({
        where: { id: input.id },
        include: {
          objective: {
            include: { cycle: true },
          },
        },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"
      const isOwner = existing.ownerId === member.id

      let isTeamLeader = false
      if (
        !isAdmin &&
        !isOwner &&
        existing.ownerId &&
        existing.objective.teamId
      ) {
        const ownerMember = await prisma.member.findUnique({
          where: { id: existing.ownerId },
        })
        if (ownerMember) {
          const tm = await prisma.teamMember.findFirst({
            where: {
              userId: ownerMember.userId,
              teamId: existing.objective.teamId,
            },
          })
          isTeamLeader = !!tm
        }
      }

      if (!isAdmin && !isOwner && !isTeamLeader) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      // Block non-admin updates when cycle is locked
      if (!isAdmin && existing.objective.cycle?.locked) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Cycle is locked." })
      }

      const restricted = !isAdmin && !isTeamLeader
      if (restricted && input.title !== undefined)
        throw new TRPCError({ code: "FORBIDDEN" })
      if (restricted && input.targetValue !== undefined)
        throw new TRPCError({ code: "FORBIDDEN" })
      if (restricted && input.unit !== undefined)
        throw new TRPCError({ code: "FORBIDDEN" })
      if (restricted && input.weight !== undefined)
        throw new TRPCError({ code: "FORBIDDEN" })
      if (restricted && input.ownerId !== undefined)
        throw new TRPCError({ code: "FORBIDDEN" })

      const data: Record<string, unknown> = {}
      if (input.title !== undefined) data.title = input.title
      if (input.description !== undefined) data.description = input.description
      if (input.targetValue !== undefined) data.targetValue = input.targetValue
      if (input.maxValue !== undefined) data.maxValue = input.maxValue
      if (input.currentValue !== undefined)
        data.currentValue = input.currentValue
      if (input.unit !== undefined) data.unit = input.unit
      if (input.weight !== undefined) data.weight = input.weight
      if (input.ownerId !== undefined) data.ownerId = input.ownerId

      const targetValue = input.targetValue ?? existing.targetValue
      const currentValue = input.currentValue ?? existing.currentValue
      data.progress = calcProgress(currentValue, targetValue)
      data.status = calcStatus(data.progress as number)

      const keyResult = await prisma.keyResult.update({
        where: { id: input.id },
        data,
        include: {
          owner: {
            include: {
              user: {
                select: { id: true, name: true, email: true, image: true },
              },
            },
          },
        },
      })

      await recalcObjectiveProgress(existing.objectiveId)

      return { keyResult }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.keyResult.findUnique({
        where: { id: input.id },
        include: {
          objective: {
            include: { cycle: true },
          },
        },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const orgId = existing.organizationId

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"

      if (!isAdmin) {
        // Block non-admin deletes when cycle is locked
        if (existing.objective.cycle?.locked) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cycle is locked.",
          })
        }

        if (!existing.objective.teamId)
          throw new TRPCError({ code: "FORBIDDEN" })

        const isTeamLeader = await prisma.team.findFirst({
          where: {
            id: existing.objective.teamId,
            leaderId: member.id,
            organizationId: orgId,
          },
        })
        if (!isTeamLeader) throw new TRPCError({ code: "FORBIDDEN" })
      }

      await prisma.$transaction(async (tx) => {
        await tx.keyResult.delete({ where: { id: input.id } })
      })

      await recalcObjectiveProgress(existing.objectiveId)

      return { success: true }
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        items: z.array(z.object({ id: z.string(), sortOrder: z.number() })),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.session.session.activeOrganizationId
      if (!orgId) throw new TRPCError({ code: "FORBIDDEN" })

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"

      // Every KR being reordered must belong to the caller's org.
      const reorderIds = [...new Set(input.items.map((i) => i.id))]
      const ownedCount = await prisma.keyResult.count({
        where: { id: { in: reorderIds }, organizationId: orgId },
      })
      if (ownedCount !== reorderIds.length) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      if (!isAdmin) {
        const firstKr = input.items[0]
        if (!firstKr) throw new TRPCError({ code: "BAD_REQUEST" })

        const kr = await prisma.keyResult.findUnique({
          where: { id: firstKr.id },
          include: {
            objective: {
              include: { cycle: true },
            },
          },
        })
        if (!kr) throw new TRPCError({ code: "NOT_FOUND" })

        if (kr.objective.cycle?.locked) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cycle is locked.",
          })
        }

        if (kr.objective.teamId) {
          const isTeamLeader = await prisma.team.findFirst({
            where: {
              id: kr.objective.teamId,
              leaderId: member.id,
              organizationId: orgId,
            },
          })
          if (!isTeamLeader) throw new TRPCError({ code: "FORBIDDEN" })
        } else if (kr.objective.ownerId) {
          const ownerMember = await prisma.member.findUnique({
            where: { id: kr.objective.ownerId },
          })
          if (!ownerMember) throw new TRPCError({ code: "BAD_REQUEST" })
          const isTeamLeader = await prisma.team.findFirst({
            where: {
              leaderId: member.id,
              members: { some: { userId: ownerMember.userId } },
            },
          })
          if (!isTeamLeader) throw new TRPCError({ code: "FORBIDDEN" })
        } else {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      }

      const firstKr = await prisma.keyResult.findUnique({
        where: { id: input.items[0]?.id ?? "none" },
      })

      await prisma.$transaction(
        input.items.map((item) =>
          prisma.keyResult.update({
            where: { id: item.id },
            data: { sortOrder: item.sortOrder },
          }),
        ),
      )

      if (firstKr) {
        await recalcObjectiveProgress(firstKr.objectiveId)
      }

      return { success: true }
    }),

  move: protectedProcedure
    .input(
      z.object({
        krId: z.string(),
        targetObjectiveId: z.string(),
        sortOrder: z.number(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const orgId = ctx.session.session.activeOrganizationId
      if (!orgId) throw new TRPCError({ code: "FORBIDDEN" })

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"

      const kr = await prisma.keyResult.findUnique({
        where: { id: input.krId },
      })
      if (!kr) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(kr.organizationId, orgId)

      // Target objective must also belong to the caller's org.
      const targetObjective = await prisma.objective.findUnique({
        where: { id: input.targetObjectiveId },
        select: { organizationId: true },
      })
      if (!targetObjective) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(targetObjective.organizationId, orgId)

      if (!isAdmin) {
        const [sourceObj, targetObj] = await Promise.all([
          prisma.objective.findUnique({
            where: { id: kr.objectiveId },
            select: { teamId: true, organizationId: true },
          }),
          prisma.objective.findUnique({
            where: { id: input.targetObjectiveId },
            select: { teamId: true, organizationId: true },
          }),
        ])
        if (!sourceObj || !targetObj) throw new TRPCError({ code: "NOT_FOUND" })

        // Check if source cycle is locked
        const sourceCycle = await prisma.objective.findUnique({
          where: { id: kr.objectiveId },
          select: { cycle: { select: { locked: true } } },
        })
        if (sourceCycle?.cycle?.locked)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Cycle is locked.",
          })

        const teamIds = new Set<string>()
        if (sourceObj.teamId) teamIds.add(sourceObj.teamId)
        if (targetObj.teamId) teamIds.add(targetObj.teamId)

        const teamLead = await prisma.team.findFirst({
          where: {
            id: { in: [...teamIds] },
            leaderId: member.id,
            organizationId: orgId,
          },
        })
        if (!teamLead) throw new TRPCError({ code: "FORBIDDEN" })
      }

      const fromObjectiveId = kr.objectiveId

      await prisma.$transaction(async (tx) => {
        await tx.keyResult.updateMany({
          where: {
            objectiveId: input.targetObjectiveId,
            sortOrder: { gte: input.sortOrder },
          },
          data: { sortOrder: { increment: 1 } },
        })

        await tx.keyResult.update({
          where: { id: input.krId },
          data: {
            objectiveId: input.targetObjectiveId,
            sortOrder: input.sortOrder,
          },
        })
      })

      await recalcObjectiveProgress(fromObjectiveId)
      if (fromObjectiveId !== input.targetObjectiveId) {
        await recalcObjectiveProgress(input.targetObjectiveId)
      }

      return { success: true }
    }),
})

async function recalcObjectiveProgress(objectiveId: string) {
  const allKrs = await prisma.keyResult.findMany({
    where: { objectiveId },
  })

  if (allKrs.length === 0) {
    await prisma.objective.update({
      where: { id: objectiveId },
      data: { progress: 0, status: "not_started" },
    })
    return
  }

  const totalWeight = allKrs.reduce((sum, kr) => sum + kr.weight, 0)
  const objectiveProgress =
    totalWeight > 0
      ? Math.round(
          (allKrs.reduce((sum, kr) => sum + kr.progress * kr.weight, 0) /
            totalWeight) *
            10,
        ) / 10
      : 0

  const avgProgress =
    allKrs.reduce((sum, kr) => sum + kr.progress, 0) / allKrs.length

  let objectiveStatus: string
  if (objectiveProgress >= 100) objectiveStatus = "completed"
  else if (objectiveProgress >= 75) objectiveStatus = "on_track"
  else if (objectiveProgress >= 50) objectiveStatus = "at_risk"
  else if (objectiveProgress > 0 || avgProgress > 0) objectiveStatus = "behind"
  else objectiveStatus = "not_started"

  await prisma.objective.update({
    where: { id: objectiveId },
    data: { progress: objectiveProgress, status: objectiveStatus },
  })
}
