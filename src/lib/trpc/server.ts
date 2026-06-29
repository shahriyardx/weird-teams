import { initTRPC, TRPCError } from "@trpc/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"

export async function createContext(opts: { headers: Headers }) {
  const session = await auth.api.getSession({ headers: opts.headers })
  return {
    session,
    headers: opts.headers,
  }
}

export type Context = Awaited<ReturnType<typeof createContext>>

const t = initTRPC.context<Context>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" })
  return next({ ctx: { ...ctx, session: ctx.session } })
})

export async function getMember(organizationId: string, userId: string) {
  return prisma.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  })
}

/**
 * Asserts a fetched resource actually belongs to the org the caller proved
 * membership of. `getMember(input.organizationId, ...)` only proves the caller
 * belongs to the org they *claim* — without this, a member of org A can act on
 * a resource fetched by bare id from org B (cross-tenant IDOR).
 */
export function assertOrg(resourceOrgId: string, expectedOrgId: string) {
  if (resourceOrgId !== expectedOrgId) {
    throw new TRPCError({ code: "FORBIDDEN" })
  }
}

export function calcProgress(objectives: { progress: number }[]) {
  if (objectives.length === 0) return 0
  return Math.round(
    objectives.reduce((sum, o) => sum + o.progress, 0) / objectives.length,
  )
}
