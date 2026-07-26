export class ConnectionOperationGate {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  begin(): number {
    this.clearTimer();
    this.generation += 1;
    return this.generation;
  }

  cancel(): number {
    return this.begin();
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  snapshot(): number {
    return this.generation;
  }

  schedule(callback: () => void, delayMs: number): void {
    this.clearTimer();
    const scheduledGeneration = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.isCurrent(scheduledGeneration)) callback();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
