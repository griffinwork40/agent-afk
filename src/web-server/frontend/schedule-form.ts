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
  if (dom === '*' && mon === '*' && dow === '*' && hour.startsWith('*/')) {
    return `Runs every ${hour.slice(2)} hours`;
  }
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
  // Step-interval patterns now handled above the daily branch.
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
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'sched-form-title');

  // Title
  const titleEl = el('h3', 'sched-modal-title', isEdit ? 'Edit Schedule' : 'New Schedule');
  titleEl.id = 'sched-form-title';
  modal.appendChild(titleEl);

  // Name
  const nameGroup = el('div', 'sched-field');
  const nameLabel = el('label', 'sched-label', 'Name');
  nameLabel.htmlFor = 'sf-name';
  nameGroup.appendChild(nameLabel);
  const nameInput = document.createElement('input');
  nameInput.id = 'sf-name';
  nameInput.type = 'text';
  nameInput.className = 'sched-input';
  nameInput.placeholder = 'e.g. Nightly forge';
  nameInput.value = schedule?.name ?? '';
  nameGroup.appendChild(nameInput);
  modal.appendChild(nameGroup);

  // Command
  const cmdGroup = el('div', 'sched-field');
  const cmdLabel = el('label', 'sched-label', 'Command');
  cmdLabel.htmlFor = 'sf-command';
  cmdGroup.appendChild(cmdLabel);
  const cmdInput = document.createElement('input');
  cmdInput.id = 'sf-command';
  cmdInput.type = 'text';
  cmdInput.className = 'sched-input sched-input-mono';
  cmdInput.placeholder = 'e.g. /forge-friction --auto';
  cmdInput.value = schedule?.command ?? '';
  cmdGroup.appendChild(cmdInput);
  modal.appendChild(cmdGroup);

  // Cron
  const cronGroup = el('div', 'sched-field');
  const cronLabel = el('label', 'sched-label', 'Schedule');
  cronLabel.htmlFor = 'sf-cron-select';
  cronGroup.appendChild(cronLabel);

  const cronSelect = document.createElement('select');
  cronSelect.id = 'sf-cron-select';
  cronSelect.className = 'sched-select';
  for (const preset of CRON_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.value;
    opt.textContent = preset.label;
    cronSelect.appendChild(opt);
  }

  const cronInput = document.createElement('input');
  cronInput.id = 'sf-cron';
  cronInput.type = 'text';
  cronInput.className = 'sched-input sched-input-mono';
  cronInput.placeholder = '0 2 * * *';
  cronInput.value = schedule?.cron ?? '';

  const cronPreview = el('div', 'sched-cron-preview');

  // Tracks whether the custom cron text input is active (true) or a preset is
  // selected (false). This is the authoritative state; never read style.display.
  let useCustomCron = false;

  // Set initial state
  const initialCron = schedule?.cron ?? '';
  const matchingPreset = CRON_PRESETS.find((p) => p.value === initialCron);
  if (matchingPreset && matchingPreset.value !== '') {
    cronSelect.value = matchingPreset.value;
    cronInput.hidden = true;
    useCustomCron = false;
  } else if (initialCron) {
    cronSelect.value = '';
    cronInput.hidden = false;
    useCustomCron = true;
  } else {
    cronSelect.value = CRON_PRESETS[0]?.value ?? '';
    cronInput.hidden = true;
    cronInput.value = cronSelect.value;
    useCustomCron = false;
  }

  const updatePreview = (): void => {
    const val = useCustomCron ? cronInput.value : cronSelect.value;
    cronPreview.textContent = val ? describeCron(val) : '';
  };

  cronSelect.addEventListener('change', () => {
    if (cronSelect.value === '') {
      cronInput.hidden = false;
      useCustomCron = true;
      cronInput.focus();
    } else {
      cronInput.hidden = true;
      useCustomCron = false;
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
  const trigLabel = el('label', 'sched-label', 'Trigger');
  trigLabel.htmlFor = 'sf-trigger';
  trigGroup.appendChild(trigLabel);
  const trigSelect = document.createElement('select');
  trigSelect.id = 'sf-trigger';
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
  const notifyLabel = el('label', 'sched-label', 'Notifications');
  notifyLabel.htmlFor = 'sf-notify';
  notifyGroup.appendChild(notifyLabel);
  const notifySelect = document.createElement('select');
  notifySelect.id = 'sf-notify';
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
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const saveBtn = el('button', 'sched-save-btn', isEdit ? 'Save Changes' : 'Create Schedule');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => {
    void save();
  });

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(saveBtn);
  modal.appendChild(btnRow);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', escHandler);
  };

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  nameInput.focus();

  // Focus trap: cycle Tab/Shift+Tab within the modal
  const focusableSelectors = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled])';
  modal.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(modal.querySelectorAll<HTMLElement>(focusableSelectors));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Close on Escape or overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', escHandler);

  async function save(): Promise<void> {
    const name = nameInput.value.trim();
    const command = cmdInput.value.trim();
    const cron = useCustomCron ? cronInput.value.trim() : cronSelect.value;

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

      close();
      opts.onSaved();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'save failed');
      saveBtn.disabled = false;
      saveBtn.textContent = isEdit ? 'Save Changes' : 'Create Schedule';
    }
  }
}
