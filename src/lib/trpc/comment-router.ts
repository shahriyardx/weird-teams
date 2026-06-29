import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { prisma } from "@/lib/prisma"
import { router, protectedProcedure, getMember } from "./server"

/**
 * Loads a task and verifies the caller may access it: must be a member of the
 * task's org, and for team-scoped tasks also a team member (or org admin/owner).
 * Returns the task + caller's member record.
 */
async function requireTaskAccess(taskId: string, userId: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } })
  if (!task) throw new TRPCError({ code: "NOT_FOUND" })

  const member = await getMember(task.organizationId, userId)
  if (!member) throw new TRPCError({ code: "FORBIDDEN" })

  const isOrgAdmin = member.role === "owner" || member.role === "admin"
  if (task.teamId && !isOrgAdmin) {
    const teamMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: task.teamId, userId } },
    })
    if (!teamMember) throw new TRPCError({ code: "FORBIDDEN" })
  }

  return { task, member, isOrgAdmin }
}

export const commentRouter = router({
  list: protectedProcedure
    .input(z.object({ taskId: z.string() }))
    .query(async ({ ctx, input }) => {
      await requireTaskAccess(input.taskId, ctx.session.user.id)

      const comments = await prisma.comment.findMany({
        where: { taskId: input.taskId },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
        orderBy: { createdAt: "asc" },
      })
      return { comments }
    }),

  create: protectedProcedure
    .input(
      z.object({
        content: z.string().min(1),
        taskId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { task } = await requireTaskAccess(
        input.taskId,
        ctx.session.user.id,
      )

      const comment = await prisma.comment.create({
        data: {
          content: input.content,
          taskId: input.taskId,
          authorId: ctx.session.user.id,
        },
        include: {
          author: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      })

      // Notify task assignees (except comment author)
      const taskWithAssignees = await prisma.task.findUnique({
        where: { id: input.taskId },
        include: {
          assignees: { include: { member: { select: { userId: true } } } },
        },
      })
      if (taskWithAssignees) {
        const notifyUserIds = taskWithAssignees.assignees
          .map((a) => a.member.userId)
          .filter((id) => id !== ctx.session.user.id)
        if (notifyUserIds.length > 0) {
          await prisma.notification.createMany({
            data: notifyUserIds.map((userId) => ({
              type: "comment_added",
              title: `New comment on "${task.title}"`,
              body: `${ctx.session.user.name}: ${input.content.slice(0, 100)}`,
              userId,
              organizationId: task.organizationId,
              taskId: task.id,
            })),
          })
        }
      }

      return { comment }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.comment.findUnique({
        where: { id: input.id },
        include: { task: { select: { organizationId: true } } },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.task.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isOrgAdmin = member.role === "owner" || member.role === "admin"
      if (existing.authorId !== ctx.session.user.id && !isOrgAdmin) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      await prisma.comment.delete({ where: { id: input.id } })
      return { success: true }
    }),
})
