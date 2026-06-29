"use client"

import { useRouter, useParams } from "next/navigation"
import Image from "next/image"
import { CaretUpDownIcon, CheckIcon, PlusIcon } from "@phosphor-icons/react"
import { useOrganization } from "@/lib/organization-context"
import { authClient } from "@/lib/auth-client"
import { api } from "@/lib/trpc/client"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

function OrgLogo({
  src,
  name,
  className,
}: {
  src?: string | null
  name: string
  className?: string
}) {
  return (
    <div
      className={`overflow-hidden flex items-center justify-center shrink-0 ${className ?? ""}`}
    >
      {src ? (
        <Image
          src={src}
          alt={name}
          width={32}
          height={32}
          className="object-cover size-full"
        />
      ) : (
        <span className="flex size-full items-center justify-center bg-sidebar-primary text-sidebar-primary-foreground text-xs font-bold">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  )
}

export function TeamSwitcher() {
  const router = useRouter()
  const params = useParams()
  const { isMobile } = useSidebar()
  const { session, organization, organizations, onSwitchOrg } =
    useOrganization()
  const slug = params.companySlug as string | undefined

  const activeTeamId = session?.session?.activeTeamId

  const { data: myTeamsData } = api.team.getMyTeams.useQuery(
    { organizationId: organization?.id ?? "" },
    { enabled: !!organization },
  )
  const teams =
    (
      myTeamsData as
        | {
            teams?: Array<{
              id: string
              name: string
              leader: { user: { id: string } } | null
            }>
          }
        | undefined
    )?.teams ?? []

  const activeTeam = teams.find((t) => t.id === activeTeamId)

  async function handleSwitchTeam(teamId: string) {
    if (teamId === activeTeamId) return
    await authClient.organization.setActiveTeam({ teamId })
    const target = teams.find((t) => t.id === teamId)
    const isLeader = target?.leader?.user.id === session?.user?.id
    router.push(isLeader ? `/${slug}/manage-team` : `/${slug}/team`)
  }

  async function handleSwitchOrg(orgId: string, orgSlug: string) {
    if (orgId === organization?.id) return
    await onSwitchOrg(orgId)
    router.push(`/${orgSlug}`)
  }

  if (!organization) return null

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <OrgLogo
                src={organization.logo}
                name={activeTeam?.name ?? organization.name}
                className="size-8 rounded-lg"
              />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {organization.name}
                </span>
                <span className="truncate text-xs">
                  {activeTeam?.name ?? "No team"}
                </span>
              </div>
              <CaretUpDownIcon className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Organizations
            </DropdownMenuLabel>
            {organizations.map((o) => (
              <DropdownMenuItem
                key={o.id}
                onClick={() => handleSwitchOrg(o.id, o.slug)}
                className="gap-2 p-2"
              >
                <OrgLogo
                  src={o.logo}
                  name={o.name}
                  className="size-6 rounded-md"
                />
                <span className="flex-1 min-w-0 truncate text-sm">
                  {o.name}
                </span>
                {o.id === organization.id && (
                  <CheckIcon className="size-4 shrink-0 text-muted-foreground" />
                )}
              </DropdownMenuItem>
            ))}
            <DropdownMenuItem
              className="gap-2 p-2"
              onClick={() => router.push("/onboard/add-organization")}
            >
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <PlusIcon className="size-4" />
              </div>
              <span className="font-medium text-muted-foreground">
                Add organization
              </span>
            </DropdownMenuItem>

            {teams.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Teams
                </DropdownMenuLabel>
                {teams.map((team) => (
                  <DropdownMenuItem
                    key={team.id}
                    onClick={() => handleSwitchTeam(team.id)}
                    className="gap-2 p-2"
                  >
                    <span className="flex size-6 items-center justify-center rounded-md border text-[10px] font-medium shrink-0">
                      {team.name.charAt(0)}
                    </span>
                    <span className="flex-1 min-w-0 truncate text-sm">
                      {team.name}
                    </span>
                    {team.id === activeTeamId && (
                      <CheckIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
