/** Closed-form damped spring: identical motion at different display refresh rates.
 * Preserve velocity when the target changes, including a hover reversal.
 */
export function springStep(position: number, velocity: number, target: number, dt: number): {position: number; velocity: number} {
  const step = Math.max(0, Math.min(.064, dt));
  const damping = 13, frequency = Math.sqrt(280 - damping * damping);
  const displacement = position - target;
  const sine = Math.sin(frequency * step), cosine = Math.cos(frequency * step);
  const envelope = Math.exp(-damping * step);
  const coefficient = (velocity + damping * displacement) / frequency;
  return {
    position: target + envelope * (displacement * cosine + coefficient * sine),
    velocity: envelope * (velocity * cosine - (damping * coefficient + displacement * frequency) * sine),
  };
}
