// Shipward shared seed data — one dataset, consumed by all three direction prototypes.
export const projects = [
  { id: 'brewnote', name: 'Brewnote', tag: 'coffee journal', prefix: 'BW' },
  { id: 'fernwood', name: 'Fernwood', tag: 'plant care', prefix: 'FW' },
  { id: 'kilowatt', name: 'Kilowatt', tag: 'home energy', prefix: 'KW' },
];

const C = (id, p, title, type, pri, effort, status, x = {}) => ({
  id, p, title, type, pri, effort, status,
  claude: null, branch: null, commit: null,
  created: '2026-07-15T10:00:00', pushed: null, shipped: null, note: '',
  ...x,
});

const ago = (min) => new Date(Date.now() - min * 60000).toISOString();

export function seedState() {
  return {
    project: 'brewnote',
    cards: [
      // Brewnote
      C('BW-021', 'brewnote', 'Grind size slider snaps back on iOS', 'bug', 'P2', 'S', 'backlog', { created: '2026-07-21T09:10:00' }),
      C('BW-020', 'brewnote', 'Offline mode for café visits', 'feature', 'P1', 'L', 'backlog', { created: '2026-07-19T14:02:00' }),
      C('BW-019', 'brewnote', 'Bump Expo SDK to 54', 'chore', 'P3', 'S', 'backlog', { created: '2026-07-18T11:30:00' }),
      C('BW-018', 'brewnote', 'Star ratings on brew logs', 'feature', 'P2', 'M', 'backlog', { created: '2026-07-16T16:45:00' }),
      C('BW-016', 'brewnote', 'Brew timer with bloom interval alerts', 'feature', 'P1', 'M', 'claude', { claude: 'working', branch: 'feat/brew-timer', created: '2026-07-14T10:20:00' }),
      C('BW-017', 'brewnote', 'History chart off by one hour after DST', 'bug', 'P2', 'S', 'claude', { claude: 'queued', branch: 'fix/history-dst', created: '2026-07-15T13:00:00' }),
      C('BW-014', 'brewnote', 'Share a brew as a recipe card image', 'feature', 'P2', 'M', 'review', { branch: 'feat/share-card', commit: '3f8c21a', created: '2026-07-10T09:00:00' }),
      C('BW-015', 'brewnote', 'Migrate settings store to MMKV', 'chore', 'P3', 'S', 'review', { branch: 'chore/mmkv-settings', commit: '9d04e7b', created: '2026-07-12T15:25:00' }),
      C('BW-012', 'brewnote', 'Bean inventory with low-stock nudge', 'feature', 'P1', 'M', 'pushed', { branch: 'feat/bean-inventory', commit: 'c71a9e2', created: '2026-07-06T10:00:00', pushed: '2026-07-23T16:20:00' }),
      C('BW-013', 'brewnote', 'Crash when tasting notes are empty', 'bug', 'P1', 'S', 'pushed', { branch: 'fix/empty-notes-crash', commit: '5b3d810', created: '2026-07-08T12:40:00', pushed: '2026-07-22T11:05:00' }),
      C('BW-011', 'brewnote', 'Tasting notes with flavor wheel', 'feature', 'P2', 'M', 'shipped', { commit: '8f02c4e', created: '2026-07-13T10:00:00', shipped: '2026-07-21T15:40:00' }),
      C('BW-010', 'brewnote', 'CI: EAS build on release tags', 'chore', 'P3', 'S', 'shipped', { commit: '77aa019', created: '2026-07-14T10:00:00', shipped: '2026-07-18T10:12:00' }),
      C('BW-009', 'brewnote', 'Pour-over step-by-step guides', 'feature', 'P2', 'L', 'shipped', { commit: '2c9d5f0', created: '2026-07-08T10:00:00', shipped: '2026-07-16T17:03:00' }),
      C('BW-008', 'brewnote', 'Duplicate log on double-tap save', 'bug', 'P2', 'S', 'shipped', { commit: 'e3b8a17', created: '2026-07-12T10:00:00', shipped: '2026-07-15T09:48:00' }),
      C('BW-007', 'brewnote', 'Water hardness calculator', 'feature', 'P3', 'M', 'shipped', { commit: '60f21bd', created: '2026-07-05T10:00:00', shipped: '2026-07-11T14:22:00' }),
      C('BW-006', 'brewnote', 'Brew history chart', 'feature', 'P2', 'M', 'shipped', { commit: '14c7e92', created: '2026-07-03T10:00:00', shipped: '2026-07-09T11:15:00' }),
      C('BW-005', 'brewnote', 'Onboarding polish pass', 'chore', 'P3', 'S', 'shipped', { commit: 'ab5533c', created: '2026-07-02T10:00:00', shipped: '2026-07-07T16:30:00' }),
      C('BW-004', 'brewnote', 'Core brew logging', 'feature', 'P1', 'L', 'shipped', { commit: '09d1f76', created: '2026-06-28T10:00:00', shipped: '2026-07-03T18:00:00' }),
      // Fernwood
      C('FW-010', 'fernwood', 'Repotting reminders', 'feature', 'P3', 'S', 'backlog', { created: '2026-07-22T10:00:00' }),
      C('FW-009', 'fernwood', 'Light meter using the camera', 'feature', 'P2', 'M', 'backlog', { created: '2026-07-20T10:00:00' }),
      C('FW-008', 'fernwood', 'Watering schedule engine from species data', 'feature', 'P1', 'L', 'claude', { claude: 'working', branch: 'feat/watering-engine', created: '2026-07-13T10:00:00' }),
      C('FW-007', 'fernwood', 'Photos upload rotated 90 degrees', 'bug', 'P2', 'S', 'review', { branch: 'fix/exif-rotation', commit: '8823f1d', created: '2026-07-17T10:00:00' }),
      C('FW-006', 'fernwood', 'Plant profiles with photo diary', 'feature', 'P1', 'M', 'pushed', { branch: 'feat/plant-profiles', commit: 'e19c774', created: '2026-07-09T10:00:00', pushed: '2026-07-23T10:30:00' }),
      C('FW-005', 'fernwood', 'Species search across 12k plants', 'feature', 'P2', 'L', 'shipped', { commit: '5d8e02a', created: '2026-07-11T10:00:00', shipped: '2026-07-19T12:00:00' }),
      C('FW-004', 'fernwood', 'Care streak badges', 'feature', 'P3', 'S', 'shipped', { commit: '91c33f7', created: '2026-07-09T10:00:00', shipped: '2026-07-14T15:10:00' }),
      C('FW-003', 'fernwood', 'Watering push notifications', 'feature', 'P2', 'M', 'shipped', { commit: 'c4a1de8', created: '2026-07-06T10:00:00', shipped: '2026-07-10T09:30:00' }),
      C('FW-002', 'fernwood', 'Plant list and detail screens', 'feature', 'P1', 'M', 'shipped', { commit: '3e7b910', created: '2026-07-02T10:00:00', shipped: '2026-07-05T17:45:00' }),
      C('FW-001', 'fernwood', 'Project scaffold and sign-in', 'chore', 'P1', 'M', 'shipped', { commit: '7f4c25b', created: '2026-06-29T10:00:00', shipped: '2026-07-01T13:20:00' }),
      // Kilowatt
      C('KW-013', 'kilowatt', 'Export usage as CSV', 'feature', 'P3', 'S', 'backlog', { created: '2026-07-21T10:00:00' }),
      C('KW-012', 'kilowatt', 'Dark mode contrast audit', 'chore', 'P3', 'S', 'backlog', { created: '2026-07-19T10:00:00' }),
      C('KW-011', 'kilowatt', 'Tariff import for EU providers', 'feature', 'P2', 'L', 'backlog', { created: '2026-07-17T10:00:00' }),
      C('KW-010', 'kilowatt', 'Anomaly alerts — catch the dying fridge', 'feature', 'P1', 'M', 'claude', { claude: 'queued', branch: 'feat/anomaly-alerts', created: '2026-07-15T10:00:00' }),
      C('KW-008', 'kilowatt', 'Live power gauge on the home screen', 'feature', 'P1', 'M', 'review', { branch: 'feat/live-gauge', commit: '41d90cc', created: '2026-07-11T10:00:00' }),
      C('KW-009', 'kilowatt', 'kWh totals drift from rounding', 'bug', 'P2', 'S', 'review', { branch: 'fix/kwh-rounding', commit: 'b7f2e03', created: '2026-07-14T10:00:00' }),
      C('KW-007', 'kilowatt', 'Solar production overlay', 'feature', 'P2', 'M', 'pushed', { branch: 'feat/solar-overlay', commit: '6acdd21', created: '2026-07-08T10:00:00', pushed: '2026-07-24T09:12:00' }),
      C('KW-006', 'kilowatt', 'Monthly cost projection', 'feature', 'P2', 'M', 'shipped', { commit: 'f0b3c9d', created: '2026-07-13T10:00:00', shipped: '2026-07-20T11:00:00' }),
      C('KW-005', 'kilowatt', 'HomeKit meter pairing', 'feature', 'P1', 'L', 'shipped', { commit: '28de461', created: '2026-07-10T10:00:00', shipped: '2026-07-17T14:00:00' }),
      C('KW-004', 'kilowatt', 'Usage history charts', 'feature', 'P2', 'M', 'shipped', { commit: '66a9f02', created: '2026-07-06T10:00:00', shipped: '2026-07-12T10:30:00' }),
      C('KW-003', 'kilowatt', 'Meter onboarding flow', 'feature', 'P1', 'M', 'shipped', { commit: 'd15b7a3', created: '2026-07-03T10:00:00', shipped: '2026-07-08T16:00:00' }),
    ],
    feed: [
      { t: ago(2), p: 'brewnote', msg: 'Claude Code started BW-016 on feat/brew-timer' },
      { t: ago(11), p: 'fernwood', msg: 'Claude Code committed progress on feat/watering-engine' },
      { t: ago(38), p: 'brewnote', msg: 'BW-017 queued for Claude Code' },
      { t: ago(55), p: 'kilowatt', msg: 'KW-010 queued for Claude Code' },
      { t: ago(178), p: 'brewnote', msg: 'Claude Code pushed 3f8c21a — BW-014 moved to Review' },
      { t: ago(305), p: 'kilowatt', msg: 'KW-007 pushed to production — nice work' },
      { t: ago(1250), p: 'brewnote', msg: 'BW-012 pushed to production — nice work' },
      { t: ago(1630), p: 'fernwood', msg: 'FW-006 pushed to production — nice work' },
    ],
  };
}
