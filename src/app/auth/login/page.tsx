import { redirect } from "next/navigation"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { safeCallbackURL } from "@/lib/utils"
import { LoginForm } from "@/components/auth/login-form"

export default async function LoginPage(props: {
  searchParams: Promise<{ callbackURL?: string }>
}) {
  const { callbackURL: rawCallbackURL } = await props.searchParams
  // Only allow safe same-origin relative paths to prevent open redirects.
  const callbackURL = rawCallbackURL
    ? safeCallbackURL(rawCallbackURL, "")
    : undefined
  const h = await headers()
  const session = await auth.api.getSession({ headers: h })

  if (session) {
    if (callbackURL) {
      redirect(callbackURL)
    }

    const member = await prisma.member.findFirst({
      where: {
        userId: session.user.id,
        status: "active",
        OR: [
          { role: { in: ["owner", "admin"] } },
          {
            organization: {
              teams: {
                some: {
                  members: {
                    some: {
                      userId: session.user.id,
                      status: "active",
                    },
                  },
                },
              },
            },
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        organizationId: true,
        organization: { select: { slug: true } },
      },
    })

    if (member) {
      await auth.api.setActiveOrganization({
        body: { organizationId: member.organizationId },
        headers: h,
      })
      redirect(`/${member.organization.slug}`)
    }

    redirect("/onboard")
  }

  return <LoginForm callbackURL={callbackURL} />
}
