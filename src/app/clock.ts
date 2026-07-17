export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class VirtualClock implements Clock {
  private current: Date;

  constructor(now: string | Date) {
    this.current = validDate(now);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(now: string | Date): Date {
    this.current = validDate(now);
    return this.now();
  }

  advance(milliseconds: number): Date {
    if (!Number.isFinite(milliseconds)) {
      throw new Error("milliseconds must be finite");
    }
    this.current = new Date(this.current.getTime() + milliseconds);
    return this.now();
  }
}

function validDate(value: string | Date): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${String(value)}`);
  }
  return date;
}
