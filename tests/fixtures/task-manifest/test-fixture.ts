export function createTasksSource(overrides: {
  tasks?: string;
} = {}): string {
  const tasks =
    overrides.tasks ??
    `## M01 · Core

- [ ] T001 Edit \`packages/core/src/index.ts\` — Acceptance: core review passes

## M02 · Follow-up

- [X] T002 Edit \`packages/core/src/follow-up.ts\` — Acceptance: follow-up review passes`;
  return `# Tasks

${tasks}
`;
}

export function createHostCanonicalTasksSource(): string {
  return `# Tasks

## M01 User authentication

- [ ] T001 [M01] Implement login validation in \`src/auth/login.ts\` — Acceptance: valid users can log in and invalid passwords return an explicit error
- [ ] T002 [M01] Add login coverage in \`src/auth/login.test.ts\` — Acceptance: success and failure cases pass
`;
}
