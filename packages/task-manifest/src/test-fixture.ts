export function createTasksSource(overrides: {
  tasks?: string;
} = {}): string {
  const tasks =
    overrides.tasks ??
    `## M01 · Core

- [ ] T001 [P] Edit \`packages/core/src/index.ts\` — 验收：core review passes

## M02 · Follow-up

- [X] T002 Edit \`packages/core/src/follow-up.ts\` — 验收：follow-up review passes`;
  return `# Tasks

${tasks}
`;
}
