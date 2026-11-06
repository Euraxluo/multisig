"use client"

import { useEffect, useState } from "react"

const QUERY = "(prefers-reduced-motion: reduce)"

/**
 * True when the user asks the OS for reduced motion. SSR and the first client
 * render return false so server markup stays stable; the media query then
 * corrects the value after mount (same pattern as `mounted` gates elsewhere).
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  return reduced
}
