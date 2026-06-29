import { type NextRequest, NextResponse } from "next/server"
import { headers } from "next/headers"
import { auth } from "@/lib/auth"
import { uploadToR2 } from "@/lib/r2"
import { MAX_UPLOAD_SIZE } from "@/lib/constants"

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null
  const imageType = (formData.get("type") as string) || "profile-images"

  if (!file || !file.type.startsWith("image/")) {
    return NextResponse.json({ error: "Invalid image file." }, { status: 400 })
  }

  if (file.size > MAX_UPLOAD_SIZE) {
    return NextResponse.json({ error: "File size too big." }, { status: 413 })
  }

  const url = await uploadToR2(file, { folder: imageType })
  if (!url) {
    return NextResponse.json({ error: "R2 not configured." }, { status: 500 })
  }

  return NextResponse.json({ url })
}
