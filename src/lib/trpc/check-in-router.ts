import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { prisma } from "@/lib/prisma"
import { router, protectedProcedure, getMember, assertOrg } from "./server"

export const checkInRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        keyResultId: z.string(),
        organizationId: z.string(),
        skip: z.number().int().min(0).default(0),
        take: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const kr = await prisma.keyResult.findUnique({
        where: { id: input.keyResultId },
        select: { organizationId: true },
      })
      if (!kr) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(kr.organizationId, input.organizationId)

      const [checkIns, total] = await prisma.$transaction(async (tx) => {
        const items = await tx.checkIn.findMany({
          where: { keyResultId: input.keyResultId },
          include: {
            author: {
              include: {
                user: {
                  select: { id: true, name: true, email: true, image: true },
                },
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: input.skip,
          take: input.take,
        })
        const count = await tx.checkIn.count({
          where: { keyResultId: input.keyResultId },
        })
        return [items, count] as const
      })
      return { checkIns, total }
    }),

  create: protectedProcedure
    .input(
      z.object({
        keyResultId: z.string(),
        newValue: z.number(),
        note: z.string().nullable().optional(),
        organizationId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isAdmin = member.role === "admin" || member.role === "owner"

      const kr = await prisma.keyResult.findUnique({
        where: { id: input.keyResultId },
        include: { objective: { include: { cycle: true } } },
      })
      if (!kr) throw new TRPCError({ code: "NOT_FOUND" })
      assertOrg(kr.organizationId, input.organizationId)

      // Permission: KR owner, admin/owner, or team leader of the objective's team can check in
      if (!isAdmin && kr.ownerId !== member.id) {
        // Check if user is a team leader for the objective's team
        if (kr.objective.teamId) {
          const teamLeader = await prisma.team.findFirst({
            where: { id: kr.objective.teamId, leaderId: member.id },
          })
          if (!teamLeader) throw new TRPCError({ code: "FORBIDDEN" })
        } else {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      }

      if (!isAdmin && kr.objective.cycle.locked) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Cycle is locked. No new check-ins allowed.",
        })
      }

      const checkIn = await prisma.$transaction(async (tx) => {
        // Create check-in
        const ci = await tx.checkIn.create({
          data: {
            previousValue: kr.currentValue,
            newValue: input.newValue,
            note: input.note ?? null,
            keyResultId: input.keyResultId,
            authorId: member.id,
            organizationId: input.organizationId,
          },
          include: {
            author: {
              include: {
                user: {
                  select: { id: true, name: true, email: true, image: true },
                },
              },
            },
          },
        })

        // Update KR values
        const krProgress =
          kr.targetValue > 0
            ? Math.min(
                100,
                Math.round((input.newValue / kr.targetValue) * 1000) / 10,
              )
            : 0
        const krStatus =
          krProgress >= 100
            ? "achieved"
            : krProgress >= 75
              ? "on_track"
              : krProgress >= 50
                ? "at_risk"
                : krProgress > 0
                  ? "behind"
                  : "not_started"

        await tx.keyResult.update({
          where: { id: input.keyResultId },
          data: {
            currentValue: input.newValue,
            progress: krProgress,
            status: krStatus,
          },
        })

        // Recalculate objective progress
        const allKrs = await tx.keyResult.findMany({
          where: { objectiveId: kr.objectiveId },
        })

        if (allKrs.length === 0) {
          await tx.objective.update({
            where: { id: kr.objectiveId },
            data: { progress: 0, status: "not_started" },
          })
        } else {
          const totalWeight = allKrs.reduce((sum, k) => sum + k.weight, 0)
          const objectiveProgress =
            totalWeight > 0
              ? Math.round(
                  (allKrs.reduce((sum, k) => sum + k.progress * k.weight, 0) /
                    totalWeight) *
                    10,
                ) / 10
              : 0

          const objectiveStatus =
            objectiveProgress >= 100
              ? "completed"
              : objectiveProgress >= 75
                ? "on_track"
                : objectiveProgress >= 50
                  ? "at_risk"
                  : objectiveProgress > 0
                    ? "behind"
                    : "not_started"

          await tx.objective.update({
            where: { id: kr.objectiveId },
            data: { progress: objectiveProgress, status: objectiveStatus },
          })
        }

        return ci
      })

      return { checkIn }
    }),
})
