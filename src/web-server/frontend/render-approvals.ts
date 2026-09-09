/**
 * Approval-card rendering for pending elicitation requests.
 *
 * Invariant: a turn BLOCKS on these. The agent is suspended inside a tool call
 * until the bridge resolves, so an approval that renders but cannot be answered
 * hangs the session with no visible cause. Every card therefore always offers a
 * terminal action — the typed inputs are conveniences layered on top of an
 * Approve/Deny pair that is present regardless of request shape.
 *
 * Invariant: NOTHING here uses innerHTML with model- or server-derived text.
 * Every value that originates from an agent or a server is placed with
 * textContent. See render.ts for the full XSS rationale.
 */

/** One request from the agent awaiting a human answer. */
export interface PendingApproval {
  id: string;
  sessionId?: string;
  createdAt?: string;
  request: {
    message?: string;
    title?: string;
    description?: string;
    serverName?: string;
    origin?: string;
    type?: 'text' | 'confirm' | 'choice' | 'multi_choice' | 'number';
    choices?: string[];
    questionDefault?: string | boolean | number;
  };
}

/** How the browser answered — mirrors ElicitationResult's action union. */
export type ApprovalAnswer =
  | { action: 'accept'; content?: Record<string, unknown> }
  | { action: 'decline' };

/** Heuristic: titles or tool names that suggest irreversible side-effects. */
const DESTRUCTIVE_RE = /bash|delete|remove|overwrite|rm |drop/i;

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

/** Returns a short wait-time string like "waiting 2m", or "" if unknown. */
function waitingLabel(createdAt: string | undefined): string {
  if (!createdAt) return '';
  const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
  return mins >= 1 ? `waiting ${mins}m` : '';
}

/**
 * Render pending approvals as actionable cards.
 *
 * Invariant: a turn BLOCKS on these. The agent is suspended inside a tool call
 * until the bridge resolves, so an approval that renders but cannot be answered
 * hangs the session with no visible cause. Every card therefore always offers a
 * terminal action — the typed inputs are conveniences layered on top of an
 * Approve/Deny pair that is present regardless of request shape.
 */
export function renderApprovals(
  container: HTMLElement,
  pending: PendingApproval[],
  onAnswer: (id: string, answer: ApprovalAnswer) => void,
): void {
  container.textContent = '';
  container.classList.toggle('has-pending', pending.length > 0);

  for (const item of pending) {
    const req = item.request ?? {};
    const title = req.title ?? req.message ?? 'The agent is waiting for a response.';

    const isDestructive = DESTRUCTIVE_RE.test(title) || DESTRUCTIVE_RE.test(req.serverName ?? '');
    const card = el('div', isDestructive ? 'approval-card approval-card--destructive' : 'approval-card');

    const head = el('div', 'approval-head');
    head.appendChild(el('span', 'approval-badge', req.origin === 'agent' ? 'question' : 'approval'));
    if (req.serverName) head.appendChild(el('span', 'approval-source', req.serverName));
    const wait = waitingLabel(item.createdAt);
    if (wait) head.appendChild(el('span', 'approval-time', wait));
    card.appendChild(head);

    card.appendChild(el('div', 'approval-title', title));
    if (req.description) {
      card.appendChild(el('div', 'approval-desc', req.description));
    }

    const actions = el('div', 'approval-actions');

    if (req.type === 'choice' && Array.isArray(req.choices) && req.choices.length > 0) {
      for (const choice of req.choices) {
        const btn = el('button', 'approval-btn', choice);
        btn.addEventListener('click', () =>
          onAnswer(item.id, { action: 'accept', content: { value: choice } }),
        );
        actions.appendChild(btn);
      }
    } else if (req.type === 'multi_choice' && Array.isArray(req.choices) && req.choices.length > 0) {
      const checkboxes = el('div', 'approval-checkboxes');
      const inputs: HTMLInputElement[] = [];
      for (const choice of req.choices) {
        const label = el('label', 'approval-checkbox-row');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = choice;
        inputs.push(cb);
        label.appendChild(cb);
        label.appendChild(el('span', undefined, choice));
        checkboxes.appendChild(label);
      }
      card.appendChild(checkboxes);
      const send = el('button', 'approval-btn approval-primary', 'Submit');
      send.addEventListener('click', () =>
        onAnswer(item.id, { action: 'accept', content: { value: inputs.filter((c) => c.checked).map((c) => c.value) } }),
      );
      actions.appendChild(send);
    } else if (req.type === 'text' || req.type === 'number') {
      const input = document.createElement('input');
      input.className = 'approval-input';
      input.type = req.type === 'number' ? 'number' : 'text';
      if (req.questionDefault !== undefined) input.value = String(req.questionDefault);
      const submit = (): void =>
        onAnswer(item.id, {
          action: 'accept',
          content: { value: req.type === 'number' ? Number(input.value) : input.value },
        });
      input.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') submit();
      });
      card.appendChild(input);
      const send = el('button', 'approval-btn approval-primary', 'Submit');
      send.addEventListener('click', submit);
      actions.appendChild(send);
    } else {
      const yes = el('button', 'approval-btn approval-primary', 'Approve');
      yes.addEventListener('click', () =>
        onAnswer(item.id, { action: 'accept', content: { value: true } }),
      );
      actions.appendChild(yes);
    }

    // Always present, whatever the request shape — see the invariant above.
    const no = el('button', 'approval-btn approval-danger', 'Deny');
    no.addEventListener('click', () => onAnswer(item.id, { action: 'decline' }));
    actions.appendChild(no);

    card.appendChild(actions);
    container.appendChild(card);
  }
}
