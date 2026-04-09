/**
 * Shared plan execution utilities for TUI and tool-side approval.
 * 
 * This module provides canonical execution labels and title extraction
 * that both the TUI and plan-approval tool can import.
 */

/**
 * Canonical execution mode labels used by both TUI and architect approval.
 * These labels must match exactly to ensure consistent UX across interfaces.
 */
export const PLAN_EXECUTION_LABELS = [
  'New session',
  'Execute here',
  'Loop (worktree)',
  'Loop',
] as const

export type PlanExecutionLabel = typeof PLAN_EXECUTION_LABELS[number]

/**
 * Extracts a title from plan content for display purposes.
 * Uses the first heading if available, otherwise falls back to first line.
 * Truncates to 60 characters with ellipsis if needed.
 */
export function extractPlanTitle(planContent: string): string {
  const headingMatch = planContent.match(/^#+\s+(.+)$/m)
  if (headingMatch?.[1]) {
    const title = headingMatch[1].trim()
    return title.length > 60 ? `${title.substring(0, 57)}...` : title
  }
  const firstLine = planContent.split('\n')[0]?.trim()
  if (firstLine) {
    return firstLine.length > 60 ? `${firstLine.substring(0, 57)}...` : firstLine
  }
  return 'Implementation Plan'
}

/**
 * Normalizes a mode string to lowercase for comparison.
 */
export function normalizeModeLabel(label: string): string {
  return label.toLowerCase()
}

/**
 * Checks if a given label matches one of the canonical execution labels.
 * Returns the matched canonical label or null if no match.
 */
export function matchExecutionLabel(input: string): PlanExecutionLabel | null {
  const normalized = normalizeModeLabel(input)
  for (const label of PLAN_EXECUTION_LABELS) {
    if (normalized === label.toLowerCase() || normalized.startsWith(label.toLowerCase())) {
      return label
    }
  }
  return null
}
