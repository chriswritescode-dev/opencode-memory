import { describe, test, expect } from 'bun:test'
import { 
  extractPlanTitle, 
  PLAN_EXECUTION_LABELS, 
  matchExecutionLabel,
  normalizeModeLabel 
} from '../src/utils/plan-execution'

describe('Plan Execution Utilities', () => {
  describe('PLAN_EXECUTION_LABELS', () => {
    test('Contains all four canonical execution labels', () => {
      expect(PLAN_EXECUTION_LABELS).toHaveLength(4)
      expect(PLAN_EXECUTION_LABELS).toContain('New session')
      expect(PLAN_EXECUTION_LABELS).toContain('Execute here')
      expect(PLAN_EXECUTION_LABELS).toContain('Loop (worktree)')
      expect(PLAN_EXECUTION_LABELS).toContain('Loop')
    })

    test('Labels match the exact strings used by plan-approval.ts', () => {
      // These are the exact labels that must match between TUI and plan-approval
      expect(PLAN_EXECUTION_LABELS[0]).toBe('New session')
      expect(PLAN_EXECUTION_LABELS[1]).toBe('Execute here')
      expect(PLAN_EXECUTION_LABELS[2]).toBe('Loop (worktree)')
      expect(PLAN_EXECUTION_LABELS[3]).toBe('Loop')
    })
  })

  describe('extractPlanTitle', () => {
    test('Extracts title from first heading', () => {
      const plan = '# My Implementation Plan\n\nSome content here...'
      expect(extractPlanTitle(plan)).toBe('My Implementation Plan')
    })

    test('Truncates long titles to 60 characters', () => {
      const longTitle = 'a'.repeat(65)
      const plan = `# ${longTitle}\n\nContent`
      const result = extractPlanTitle(plan)
      expect(result.length).toBe(60)
      expect(result).toBe('a'.repeat(57) + '...')
    })

    test('Falls back to first line if no heading', () => {
      const plan = 'Implementation Plan\n\nSome content'
      expect(extractPlanTitle(plan)).toBe('Implementation Plan')
    })

    test('Falls back to default if plan is empty', () => {
      expect(extractPlanTitle('')).toBe('Implementation Plan')
    })

    test('Trims whitespace from extracted title', () => {
      const plan = '#   Title with spaces   \n\nContent'
      expect(extractPlanTitle(plan)).toBe('Title with spaces')
    })
  })

  describe('normalizeModeLabel', () => {
    test('Converts to lowercase', () => {
      expect(normalizeModeLabel('New Session')).toBe('new session')
      expect(normalizeModeLabel('LOOP')).toBe('loop')
    })

    test('Handles exact canonical labels', () => {
      expect(normalizeModeLabel('New session')).toBe('new session')
      expect(normalizeModeLabel('Execute here')).toBe('execute here')
      expect(normalizeModeLabel('Loop (worktree)')).toBe('loop (worktree)')
      expect(normalizeModeLabel('Loop')).toBe('loop')
    })
  })

  describe('matchExecutionLabel', () => {
    test('Matches exact canonical labels', () => {
      expect(matchExecutionLabel('New session')).toBe('New session')
      expect(matchExecutionLabel('Execute here')).toBe('Execute here')
      expect(matchExecutionLabel('Loop (worktree)')).toBe('Loop (worktree)')
      expect(matchExecutionLabel('Loop')).toBe('Loop')
    })

    test('Matches case-insensitively', () => {
      expect(matchExecutionLabel('new session')).toBe('New session')
      expect(matchExecutionLabel('EXECUTE HERE')).toBe('Execute here')
      expect(matchExecutionLabel('LOOP (WORKTREE)')).toBe('Loop (worktree)')
      expect(matchExecutionLabel('loop')).toBe('Loop')
    })

    test('Matches partial labels that start with canonical label', () => {
      expect(matchExecutionLabel('New session (custom)')).toBe('New session')
      expect(matchExecutionLabel('Loop (worktree) variant')).toBe('Loop (worktree)')
    })

    test('Returns null for non-matching labels', () => {
      expect(matchExecutionLabel('Custom mode')).toBeNull()
      expect(matchExecutionLabel('Execute there')).toBeNull()
      expect(matchExecutionLabel('')).toBeNull()
    })

    test('Does not match partial text in middle', () => {
      // Should not match "I want to loop" as "Loop"
      expect(matchExecutionLabel('I want to loop')).toBeNull()
    })
  })
})
