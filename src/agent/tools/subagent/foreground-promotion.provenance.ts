/**
 * Prepend a compact provenance header naming the subagent's model — but ONLY
 * when it differs from the parent's. That is the mixed-model fan-out case where
 * the parent benefits from knowing which model produced a finding (trust
 * calibration: a result from a cheaper/different model warrants independent
 * checking). When the child inherited the parent's model the header is pure
 * noise and is omitted, so same-model dispatches stay byte-for-byte unchanged.
 * Descriptive metadata, not an instruction.
 *
 * @module agent/tools/subagent/foreground-promotion.provenance
 */

export function withProvenanceHeader(
  content: string,
  model: string | undefined,
  parentModel: string | undefined,
): string {
  if (!model || !parentModel || model === parentModel) return content;
  return `[subagent result · model=${model} (parent: ${parentModel})]\n\n${content}`;
}
