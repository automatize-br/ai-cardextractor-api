let active = 0

export function beginExtraction(): void {
  active += 1
}

export function endExtraction(): void {
  active = Math.max(0, active - 1)
}

export function activeExtractions(): number {
  return active
}
