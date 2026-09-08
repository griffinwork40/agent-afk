/**
 * Create/edit form for scheduled tasks.
 *
 * Renders an overlay modal with fields for name, command, cron expression
 * (with human-readable preview), trigger mode, and notify settings.
 * All DOM construction uses textContent -- never innerHTML.
 */

import { showToast } from './app-chrome.js';
import type { ScheduleConfig } from './schedules-view.js';

interface ScheduleFormOptions {
  api: <T>(path: string, init?: RequestInit) => Promise<T>;
  onSaved: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at 2:00 AM', value: '0 2 * * *' },
  { label: 'Daily at 9:00 AM', value: '0 9 * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Weekly (Monday 9 AM)', value: '0 9 * * 1' },
  { label: 'Custom...', value: '' },
];

function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return '';
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (dom === '*' && mon === '*' && dow === '*' && hour !== '*' && min !== '*') {
    return `Runs daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && dow !== '*' && hour !== '*') {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = days[Number(dow)] ?? dow;
    return `Runs every ${dayName} at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (dom === '*' && mon === '*' && dow === '*' && hour === '*') {
    return min === '*' ? 'Runs every minute' : `Runs every hour at :${min.padStart(2, '0')}`;
  }
  if (hour === '*/6' || hour === '*/4' || hour === '*/2' || hour === '*/8' || hour === '*/12') {
    return `Runs every ${hour.slice(2)} hours`;
  }
  return `Cron: ${expr}`;
}

export function openScheduleForm(
  schedule: ScheduleConfig | null,
  opts: ScheduleFormOptions,
): void {
  const isEdit = schedule !== null && schedule.id !== '';

  // Remove any existing form overlay
  document.getElementById('sched-form-overlay')?.remove();

  const overlay = el('div', 'sched-overlay');
  overlay.id = 'sched-form-overlay';

  const modal = el('div', 'sched-modal');

  // Title
  modal.appendChild(el('h3', 'sched-modal-title', isEdit ? 'Edit Schedule' : 'New Schedule'));

  // Name
  const nameGroup = el('div', 'sched-field');
  nameGroup.appendChild(el('label', 'sched-label', 'Name'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'sched-input';
  nameInput.placeholder = 'e.g. Nightly forge';
  nameInput.value = schedule?.name ?? '';
  nameGroup.appendChild(nameInput);
  modal.appendChild(nameGroup);

  // Command
  const cmdGroup = el('div', 'sched-field');
  cmdGroup.appendChild(el('label', 'sched-label', 'Command'));
  const cmdInput = document.createElement('input');
  cmdInput.type = 'text';
  cmdInput.className = 'sched-input sched-input-mono';
  cmdInput.placeholder = 'e.g. /forge-friction --auto';
  cmdInput.value = schedule?.command ?? '';
  cmdGroup.appendChild(cmdInput);
  modal.appendChild(cmdGroup);

  // Cron
  const cronGroup = el('div', 'sched-field');
  cronGroup.appendChild(el('label', 'sched-label', 'Schedule'));

  const cronSelect = document.createElement('select');
  cronSelect.className = 'sched-select';
  for (const preset of CRON_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.value;
    opt.textContent = preset.label;
    cronSelect.appendChild(opt);
  }

  const cronInput = document.createElement('input');
  cronInput.type = 'text';
  cronInput.className = 'sched-input sched-input-mono';
  cronInput.placeholder = '0 2 * * *';
  cronInput.value = schedule?.cron ?? '';

  const cronPreview = el('div', 'sched-cron-preview');

  // Set initial state
  const initialCron = schedule?.cron ?? '';
  const matchingPreset = CRON_PRESETS.find((p) => p.value === initialCron);
  if (matchingPreset && matchingPreset.value !== '') {
    cronSelect.value = matchingPreset.value;
    cronInput.style.display = 'none';
  } else if (initialCron) {
    cronSelect.value = '';
    cronInput.style.display = '';
  } else {
    cronSelect.value = CRON_PRESETS[0]?.value ?? '';
    cronInput.style.display = 'none';
    cronInput.value = cronSelect.value;
  }

  const updatePreview = (): void => {
    const val = cronInput.style.display === 'none' ? cronSelect.value : cronInput.value;
    cronPreview.textContent = val ? describeCron(val) : '';
  };

  cronSelect.addEventListener('change', () => {
    if (cronSelect.value === '') {
      cronInput.style.display = '';
      cronInput.focus();
    } else {
      cronInput.style.display = 'none';
      cronInput.value = cronSelect.value;
    }
    updatePreview();
  });
  cronInput.addEventListener('input', updatePreview);
  updatePreview();

  cronGroup.appendChild(cronSelect);
  cronGroup.appendChild(cronInput);
  cronGroup.appendChild(cronPreview);
  modal.appendChild(cronGroup);

  // Trigger mode
  const trigGroup = el('div', 'sched-field');
  trigGroup.appendChild(el('label', 'sched-label', 'Trigger'));
  const trigSelect = document.createElement('select');
  trigSelect.className = 'sched-select';
  for (const [val, label] of [
    ['cron', 'Cron schedule only'],
    ['sessionstart', 'On daemon start'],
    ['both', 'Both (cron + daemon start)'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === (schedule?.trigger ?? 'cron')) opt.selected = true;
    trigSelect.appendChild(opt);
  }
  trigGroup.appendChild(trigSelect);
  modal.appendChild(trigGroup);

  // Notify
  const notifyGroup = el('div', 'sched-field');
  notifyGroup.appendChild(el('label', 'sched-label', 'Notifications'));
  const notifySelect = document.createElement('select');
  notifySelect.className = 'sched-select';
  for (const [val, label] of [
    ['failure', 'On failure only'],
    ['always', 'On every run'],
    ['never', 'Never'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = label;
    if (val === (schedule?.notifyOn ?? 'failure')) opt.selected = true;
    notifySelect.appendChild(opt);
  }
  notifyGroup.appendChild(notifySelect);
  modal.appendChild(notifyGroup);

  // Buttons
  const btnRow = el('div', 'sched-btn-row');
  const cancelBtn = el('button', 'sched-cancel-btn', 'Cancel');
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = el('button', 'sched-save-btn', isEdit ? 'Save Changes' : 'Create Schedule');
  saveBtn.addEventListener('click', () => {
    void save();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  nameInput.focus();

  // Close on Escape or overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  async function save(): Promise<void> {
    const name = nameInput.value.trim();
    const command = cmdInput.value.trim();
    const cron = cronInput.style.display === 'none' ? cronSelect.value : cronInput.value.trim();

    if (!name || !command || !cron) {
      showToast('Name, command, and schedule are required');
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
      const payload = {
        name,
        command,
        cron,
        trigger: trigSelect.value,
        notifyOn: notifySelect.value,
        enabled: schedule?.enabled ?? true,
      };

      if (isEdit) {
        await opts.api(`/api/schedules/${encodeURIComponent(schedule!.id)}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        await opts.api('/api/schedules', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }

      overlay.remove();
      document.removeEventListener('keydown', escHandler);
      opts.onSaved();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'save failed');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Schedule';
    }
  }
}
