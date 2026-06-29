import { betterAuth, APIError } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { organization } from "better-auth/plugins/organization"
import { twoFactor } from "better-auth/plugins"
import { passkey } from "@better-auth/passkey"
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned"
import { sentinel, dash } from "@better-auth/infra"
import { prisma } from "./prisma"
import {
  sendInvitationEmail,
  sendVerificationEmail as sendVerificationEmailFn,
  sendResetPasswordEmail,
} from "./email"

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendResetPasswordEmail({ to: user.email, url })
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmailFn({ to: user.email, url })
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID as string,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
    },
  },
  plugins: [
    dash(),
    sentinel({
      security: {
        credentialStuffing: {
          enabled: true,
          thresholds: { challenge: 3, block: 5 },
        },
        velocity: {
          enabled: true,
          thresholds: { challenge: 10, block: 20 },
          action: "block",
        },
        compromisedPassword: {
          enabled: true,
          action: "block",
        },
        emailValidation: {
          enabled: true,
          strictness: "low",
          action: "block",
        },
        emailNormalization: { enabled: true },
      },
    }),
    haveIBeenPwned(),
    passkey(),
    twoFactor({ allowPasswordless: true }),
    organization({
      teams: { enabled: true },
      requireEmailVerificationOnInvitation: true,
      organizationHooks: {
        beforeCreateOrganization: async ({ user }) => {
          if (!user.emailVerified) {
            throw new APIError("BAD_REQUEST", {
              message:
                "You must verify your email before creating an organization.",
            })
          }
        },
      },
      schema: {
        organization: {
          additionalFields: {
            websiteUrl: { type: "string", required: false },
            department: { type: "string", required: false },
            teamSize: { type: "string", required: false },
          },
        },
        teamMember: {
          // @ts-expect-error: idk
          additionalFields: {
            role: { type: "string" },
          },
        },
      },
      sendInvitationEmail: async (data) => {
        const q = `org=${encodeURIComponent(data.organization.name)}&slug=${data.organization.slug}&role=${data.role}&inviter=${encodeURIComponent(data.inviter.user.email)}&email=${encodeURIComponent(data.email)}`
        const url = `${process.env.BETTER_AUTH_URL}/invitation/${data.id}?${q}`
        await sendInvitationEmail({
          to: data.email,
          organizationName: data.organization.name,
          inviterName: data.inviter.user.name,
          role: data.role,
          acceptUrl: url,
        })
      },
    }),
  ],
})
