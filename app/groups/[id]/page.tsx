"use client"

import { useParams, useRouter } from "next/navigation"
import { GroupDetailsView } from "@/components/group-details-view"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Home } from "lucide-react"
import { useI18n } from "@/components/i18n-provider"
import Link from "next/link"

export default function GroupDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { t } = useI18n()
  const id = typeof params?.id === "string" ? params.id : Array.isArray(params?.id) ? params.id[0] : ""

  return (
    <div className="min-h-screen bg-background text-foreground pb-24">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-md px-4 py-3">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => router.push("/")}
              className="gap-2 text-muted-foreground hover:text-foreground font-medium"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>{t("common.back") || "返回"}</span>
            </Button>
            <div className="h-4 w-px bg-border mx-1" />
            <Link
              href="/"
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <Home className="h-3.5 w-3.5" />
              <span>仪表盘</span>
            </Link>
            <span className="text-xs text-muted-foreground">/</span>
            <span className="text-xs font-medium text-foreground">群组详情</span>
          </div>
          <div className="text-xs text-muted-foreground font-mono bg-muted/50 px-2 py-1 rounded-md">
            {id ? (id.length > 18 ? `${id.slice(0, 8)}...${id.slice(-6)}` : id) : ""}
          </div>
        </div>
      </header>
      <main className="max-w-4xl mx-auto px-4 py-6">
        {id ? (
          <GroupDetailsView groupId={id} />
        ) : (
          <div className="text-center py-16 text-muted-foreground">群组未找到</div>
        )}
      </main>
    </div>
  )
}
