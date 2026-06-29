import { z } from "zod"
import { TRPCError } from "@trpc/server"
import { prisma } from "@/lib/prisma"
import type { Prisma } from "../../generated/prisma/client"
import { router, protectedProcedure, getMember } from "./server"

const assigneesInclude = {
  include: {
    member: {
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    },
  },
} as const

async function createNotifications(
  userIds: string[],
  type: string,
  title: string,
  body: string | undefined,
  organizationId: string,
  taskId: string | undefined,
) {
  if (userIds.length === 0) return
  await prisma.notification.createMany({
    data: userIds.map((userId) => ({
      type,
      title,
      body,
      userId,
      organizationId,
      taskId,
    })),
  })
}

export const taskRouter = router({
  listOrgTasks: protectedProcedure
    .input(z.object({ mode: z.enum(["assigned"]).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const orgId = ctx.session.session.activeOrganizationId
      if (!orgId)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active organization",
        })

      const member = await getMember(orgId, ctx.session.user.id)
      if (!member || (member.role !== "owner" && member.role !== "admin")) {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      const where: Prisma.TaskWhereInput = {
        organizationId: orgId,
        teamId: null,
      }
      if (input?.mode === "assigned") {
        where.createdById = ctx.session.user.id
      }

      const tasks = await prisma.task.findMany({
        where,
        include: {
          assignees: assigneesInclude,
          createdBy: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      })

      return { tasks, total: tasks.length }
    }),

  listTeamTasks: protectedProcedure
    .input(z.object({ mode: z.enum(["assigned"]).optional() }).optional())
    .query(async ({ ctx, input }) => {
      const teamId = ctx.session.session.activeTeamId
      if (!teamId)
        throw new TRPCError({ code: "BAD_REQUEST", message: "No active team" })

      const teamMember = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: ctx.session.user.id } },
      })
      if (!teamMember) throw new TRPCError({ code: "FORBIDDEN" })

      const team = await prisma.team.findUnique({
        where: { id: teamId },
        select: { organizationId: true },
      })
      if (!team) throw new TRPCError({ code: "NOT_FOUND" })

      const where: Prisma.TaskWhereInput = {
        teamId,
        organizationId: team.organizationId,
      }

      if (input?.mode === "assigned") {
        where.createdById = ctx.session.user.id
      }

      const tasks = await prisma.task.findMany({
        where,
        include: {
          assignees: assigneesInclude,
          createdBy: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
      })

      return { tasks, total: tasks.length }
    }),

  listMyTeamTasks: protectedProcedure.query(async ({ ctx }) => {
    const orgId = ctx.session.session.activeOrganizationId
    if (!orgId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No active organization",
      })

    const teamId = ctx.session.session.activeTeamId
    if (!teamId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "No active team" })

    const member = await getMember(orgId, ctx.session.user.id)
    if (!member) throw new TRPCError({ code: "FORBIDDEN" })

    const tasks = await prisma.task.findMany({
      where: {
        organizationId: orgId,
        teamId,
        assignees: { some: { memberId: member.id } },
      },
      include: {
        assignees: assigneesInclude,
        createdBy: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    })

    return { tasks, total: tasks.length }
  }),

  listMyOrgTasks: protectedProcedure.query(async ({ ctx }) => {
    const orgId = ctx.session.session.activeOrganizationId
    if (!orgId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No active organization",
      })

    const member = await getMember(orgId, ctx.session.user.id)
    if (!member) throw new TRPCError({ code: "FORBIDDEN" })

    const tasks = await prisma.task.findMany({
      where: {
        organizationId: orgId,
        teamId: null,
        assignees: { some: { memberId: member.id } },
      },
      include: {
        assignees: assigneesInclude,
        createdBy: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
    })

    return { tasks, total: tasks.length }
  }),

  listOrgAssignableMembers: protectedProcedure.query(async ({ ctx }) => {
    const orgId = ctx.session.session.activeOrganizationId
    if (!orgId)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "No active organization",
      })

    const member = await getMember(orgId, ctx.session.user.id)
    if (!member) throw new TRPCError({ code: "FORBIDDEN" })

    const members = await prisma.member.findMany({
      where: {
        organizationId: orgId,
        OR: [{ role: "owner" }, { role: "admin" }, { teamsLed: { some: {} } }],
      },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "asc" },
    })

    return { members }
  }),

  listTeamAssignableMember: protectedProcedure.query(async ({ ctx }) => {
    const teamId = ctx.session.session.activeTeamId
    if (!teamId)
      throw new TRPCError({ code: "BAD_REQUEST", message: "No active team" })

    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { organizationId: true },
    })
    if (!team) throw new TRPCError({ code: "NOT_FOUND" })

    const member = await getMember(team.organizationId, ctx.session.user.id)
    if (!member) throw new TRPCError({ code: "FORBIDDEN" })

    const teamMember = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: ctx.session.user.id } },
    })
    if (!teamMember) throw new TRPCError({ code: "FORBIDDEN" })

    const allTeamMembers = await prisma.teamMember.findMany({
      where: { teamId },
      select: { userId: true, role: true },
    })

    const memberUserIds = allTeamMembers.map((tm) => tm.userId)
    const leaderUserId = allTeamMembers.find(
      (tm) => tm.role === "leader",
    )?.userId

    const orgMembers = await prisma.member.findMany({
      where: {
        organizationId: team.organizationId,
        userId: { in: memberUserIds },
      },
      include: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
    })

    const isLeader = teamMember.role === "leader"
    const filtered = isLeader
      ? orgMembers
      : orgMembers.filter((m) => m.userId !== leaderUserId)

    return { members: filtered }
  }),

  getSidebarCounts: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        teamId: z.string().nullable().optional(),
        dashboard: z.enum(["owner", "leader", "member"]),
      }),
    )
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) {
        return { myTasks: 0, orgTasks: 0, teamTasks: 0, assignedTasks: 0 }
      }

      const isOwner = input.dashboard === "owner"
      const teamId = input.teamId ?? undefined

      const [myTasks, orgTasks, teamTasks, assignedTasks] = await Promise.all([
        // My tasks: todo status, assigned to me, scoped to dashboard
        prisma.task.count({
          where: {
            organizationId: input.organizationId,
            status: "todo",
            assignees: { some: { memberId: member.id } },
            ...(isOwner ? { teamId: null } : teamId ? { teamId } : {}),
          },
        }),
        // Organization Tasks: teamId null, todo, assigned to me
        prisma.task.count({
          where: {
            organizationId: input.organizationId,
            status: "todo",
            teamId: null,
            assignees: { some: { memberId: member.id } },
          },
        }),
        // Team Tasks: scoped to active team, todo, assigned to me
        prisma.task.count({
          where: {
            organizationId: input.organizationId,
            status: "todo",
            assignees: { some: { memberId: member.id } },
            ...(teamId ? { teamId } : { teamId: null }),
          },
        }),
        // Assigned Tasks: every todo assigned to me across the org (unscoped)
        prisma.task.count({
          where: {
            organizationId: input.organizationId,
            status: "todo",
            assignees: { some: { memberId: member.id } },
          },
        }),
      ])

      return { myTasks, orgTasks, teamTasks, assignedTasks }
    }),

  getTodoCount: protectedProcedure
    .input(
      z.object({
        organizationId: z.string(),
        teamId: z.string().nullable().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) return { count: 0 }

      const count = await prisma.task.count({
        where: {
          organizationId: input.organizationId,
          status: "todo",
          ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
          assignees: { some: { memberId: member.id } },
        },
      })
      return { count }
    }),

  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        dueDate: z.string().nullable().optional(),
        assigneeIds: z.array(z.string()).optional(),
        organizationId: z.string(),
        teamId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const member = await getMember(input.organizationId, ctx.session.user.id)
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      // If team task, verify user belongs to team; if org-level, only owner/admin
      if (input.teamId) {
        const teamMember = await prisma.teamMember.findUnique({
          where: {
            teamId_userId: {
              teamId: input.teamId,
              userId: ctx.session.user.id,
            },
          },
        })
        if (!teamMember) throw new TRPCError({ code: "FORBIDDEN" })
      } else if (member.role !== "admin" && member.role !== "owner") {
        throw new TRPCError({ code: "FORBIDDEN" })
      }

      // Validate all assignees belong to this org
      if (input.assigneeIds?.length) {
        const assigneeCount = await prisma.member.count({
          where: {
            id: { in: input.assigneeIds },
            organizationId: input.organizationId,
          },
        })
        if (assigneeCount !== input.assigneeIds.length) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid assignee",
          })
        }
      }

      const task = await prisma.task.create({
        data: {
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? "todo",
          priority: input.priority ?? "medium",
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          createdById: ctx.session.user.id,
          organizationId: input.organizationId,
          teamId: input.teamId ?? null,
          ...(input.assigneeIds?.length
            ? {
                assignees: {
                  create: input.assigneeIds.map((memberId) => ({ memberId })),
                },
              }
            : {}),
        },
        include: {
          assignees: assigneesInclude,
          createdBy: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      })

      // Notify assignees
      if (input.assigneeIds?.length) {
        const assigneeUsers = await prisma.member.findMany({
          where: { id: { in: input.assigneeIds } },
          select: { userId: true },
        })
        const notifyUserIds = assigneeUsers
          .map((m) => m.userId)
          .filter((id) => id !== ctx.session.user.id)
        await createNotifications(
          notifyUserIds,
          "task_assigned",
          `New task: ${task.title}`,
          `Assigned by ${ctx.session.user.name}`,
          input.organizationId,
          task.id,
        )
      }

      return { task }
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        status: z.string().optional(),
        priority: z.string().optional(),
        dueDate: z.string().nullable().optional(),
        assigneeIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.task.findUnique({
        where: { id: input.id },
        include: { assignees: assigneesInclude },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      // Scope permission check
      if (existing.teamId) {
        // Team task: team leader or creator can edit
        const isLeader = await prisma.team.findFirst({
          where: {
            id: existing.teamId,
            organizationId: existing.organizationId,
            leaderId: member.id,
          },
        })
        if (!isLeader && existing.createdById !== ctx.session.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      } else {
        // Org-level task: owner/admin or creator can edit
        if (
          member.role !== "admin" &&
          member.role !== "owner" &&
          existing.createdById !== ctx.session.user.id
        ) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      }

      // If updating assignees, validate and replace
      if (input.assigneeIds !== undefined) {
        if (input.assigneeIds.length > 0) {
          const assigneeCount = await prisma.member.count({
            where: {
              id: { in: input.assigneeIds },
              organizationId: existing.organizationId,
            },
          })
          if (assigneeCount !== input.assigneeIds.length) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Invalid assignee",
            })
          }
        }

        await prisma.taskAssignee.deleteMany({ where: { taskId: input.id } })
        if (input.assigneeIds.length > 0) {
          await prisma.taskAssignee.createMany({
            data: input.assigneeIds.map((memberId) => ({
              taskId: input.id,
              memberId,
            })),
          })
        }
      }

      const task = await prisma.task.update({
        where: { id: input.id },
        data: {
          ...(input.title !== undefined && { title: input.title }),
          ...(input.description !== undefined && {
            description: input.description,
          }),
          ...(input.status !== undefined && { status: input.status }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.dueDate !== undefined && {
            dueDate: input.dueDate ? new Date(input.dueDate) : null,
          }),
        },
        include: {
          assignees: assigneesInclude,
          createdBy: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      })

      // Notify only relevant parties on status change
      if (input.status !== undefined && task.assignees.length > 0) {
        const assigneeUserIds = task.assignees.map((a) => a.member.user.id)
        const isActingUserAssignee = assigneeUserIds.includes(
          ctx.session.user.id,
        )
        const isActingUserCreator = task.createdById === ctx.session.user.id

        let notifyUserIds: string[]
        if (isActingUserCreator) {
          // Creator changed status → notify assignees
          notifyUserIds = assigneeUserIds.filter(
            (id) => id !== ctx.session.user.id,
          )
        } else if (isActingUserAssignee) {
          // Assignee changed status → notify creator
          notifyUserIds = [task.createdById].filter(
            (id) => id !== ctx.session.user.id,
          )
        } else {
          // Someone else (team leader) → notify creator + assignees
          notifyUserIds = [
            ...new Set([...assigneeUserIds, task.createdById]),
          ].filter((id) => id !== ctx.session.user.id)
        }

        if (notifyUserIds.length > 0) {
          await createNotifications(
            notifyUserIds,
            "status_changed",
            `Task "${task.title}" moved to ${input.status.replace("_", " ")}`,
            undefined,
            existing.organizationId,
            task.id,
          )
        }
      }

      return { task }
    }),

  changeStatus: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        status: z.enum(["todo", "in_progress", "done"]),
        sortOrder: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.task.findUnique({
        where: { id: input.id },
        include: { assignees: assigneesInclude },
      })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      // Allow creator, team leader, org admin/owner, or assignee to change status
      const isAssignee = existing.assignees.some(
        (a) => a.member.user.id === ctx.session.user.id,
      )
      const isOwnerAdmin = member.role === "owner" || member.role === "admin"

      if (existing.teamId) {
        const isLeader = await prisma.team.findFirst({
          where: {
            id: existing.teamId,
            organizationId: existing.organizationId,
            leaderId: member.id,
          },
        })
        if (
          !isLeader &&
          !isOwnerAdmin &&
          existing.createdById !== ctx.session.user.id &&
          !isAssignee
        ) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      } else {
        if (
          !isOwnerAdmin &&
          existing.createdById !== ctx.session.user.id &&
          !isAssignee
        ) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      }

      const task = await prisma.task.update({
        where: { id: input.id },
        data: {
          status: input.status,
          ...(input.sortOrder !== undefined
            ? { sortOrder: input.sortOrder }
            : {}),
        },
        include: {
          assignees: assigneesInclude,
          createdBy: {
            select: { id: true, name: true, email: true, image: true },
          },
        },
      })

      // Notify
      if (task.assignees.length > 0) {
        const assigneeUserIds = task.assignees.map((a) => a.member.user.id)
        const isActingUserAssignee = assigneeUserIds.includes(
          ctx.session.user.id,
        )
        const isActingUserCreator = task.createdById === ctx.session.user.id

        let notifyUserIds: string[]
        if (isActingUserCreator) {
          notifyUserIds = assigneeUserIds.filter(
            (id) => id !== ctx.session.user.id,
          )
        } else if (isActingUserAssignee) {
          notifyUserIds = [task.createdById].filter(
            (id) => id !== ctx.session.user.id,
          )
        } else {
          notifyUserIds = [
            ...new Set([...assigneeUserIds, task.createdById]),
          ].filter((id) => id !== ctx.session.user.id)
        }

        if (notifyUserIds.length > 0) {
          await createNotifications(
            notifyUserIds,
            "status_changed",
            `Task "${task.title}" moved to ${input.status.replace("_", " ")}`,
            undefined,
            existing.organizationId,
            task.id,
          )
        }
      }

      return { task }
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        items: z.array(z.object({ id: z.string(), sortOrder: z.number() })),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const taskIds = [...new Set(input.items.map((i) => i.id))]
      const tasks = await prisma.task.findMany({
        where: { id: { in: taskIds } },
        include: { assignees: assigneesInclude },
      })
      if (tasks.length !== taskIds.length)
        throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        tasks[0].organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      const isOwnerAdmin = member.role === "owner" || member.role === "admin"

      for (const task of tasks) {
        const isAssignee = task.assignees.some(
          (a) => a.member.user.id === ctx.session.user.id,
        )

        if (task.teamId) {
          const isLeader = await prisma.team.findFirst({
            where: {
              id: task.teamId,
              organizationId: task.organizationId,
              leaderId: member.id,
            },
          })
          if (
            !isLeader &&
            !isOwnerAdmin &&
            task.createdById !== ctx.session.user.id &&
            !isAssignee
          ) {
            throw new TRPCError({ code: "FORBIDDEN" })
          }
        } else {
          if (
            !isOwnerAdmin &&
            task.createdById !== ctx.session.user.id &&
            !isAssignee
          ) {
            throw new TRPCError({ code: "FORBIDDEN" })
          }
        }
      }

      await prisma.$transaction(
        input.items.map((item) =>
          prisma.task.update({
            where: { id: item.id },
            data: { sortOrder: item.sortOrder },
          }),
        ),
      )

      return { success: true }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await prisma.task.findUnique({ where: { id: input.id } })
      if (!existing) throw new TRPCError({ code: "NOT_FOUND" })

      const member = await getMember(
        existing.organizationId,
        ctx.session.user.id,
      )
      if (!member) throw new TRPCError({ code: "FORBIDDEN" })

      // Scope permission check
      if (existing.teamId) {
        const isLeader = await prisma.team.findFirst({
          where: {
            id: existing.teamId,
            organizationId: existing.organizationId,
            leaderId: member.id,
          },
        })
        if (!isLeader && existing.createdById !== ctx.session.user.id) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      } else {
        if (
          member.role !== "admin" &&
          member.role !== "owner" &&
          existing.createdById !== ctx.session.user.id
        ) {
          throw new TRPCError({ code: "FORBIDDEN" })
        }
      }

      await prisma.task.delete({ where: { id: input.id } })
      return { success: true }
    }),
})
