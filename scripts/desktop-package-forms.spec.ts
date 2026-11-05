/** NovaFlow uses one release form and version for both supported desktop targets. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

it('shares one release tag, source commit and version across Windows and Apple Silicon', () => {
  const workflow = yaml.load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/novaflow-desktop-release.yml'), 'utf8')) as {
    on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } }
    jobs: { package: {
      needs: string
      env: Record<string, string>
      strategy: { matrix: { include: { target: string; command: string }[] } }
      steps: { uses?: string; run?: string; with?: Record<string, string> }[]
    } }
  }
  expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(['tag', 'reuse_run_id'])
  expect(workflow.on.workflow_dispatch.inputs.tag).toMatchObject({ required: true, type: 'string' })
  const job = workflow.jobs.package
  expect(job.needs).toBe('prepare')
  expect(job.env.VERSION).toBe('${{ needs.prepare.outputs.version }}')
  expect(job.strategy.matrix.include.map(({ target, command }) => ({ target, command }))).toEqual([
    { target: 'win-x64', command: 'package:win:x64:unsigned' },
    { target: 'mac-arm64', command: 'package:mac:arm64:unsigned' },
  ])
  expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.ref)
    .toBe('${{ needs.prepare.outputs.commit }}')
  const commands = job.steps.flatMap(step => step.run?.includes('matrix.command') ? [step.run] : [])
  expect(commands).toEqual([
    'pnpm --dir apps/desktop run "${{ matrix.command }}" --build-version "$VERSION"',
    'pnpm --dir apps/desktop run "${{ matrix.command }}" --build-version "$env:VERSION"',
  ])
})
