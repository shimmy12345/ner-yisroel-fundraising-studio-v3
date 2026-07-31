"use client";

import { useEffect, useState } from "react";

const displayDate = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
});

const machineDate = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function millisecondsUntilTomorrow(now: Date): number {
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}

export function LocalDate() {
  const [currentDate, setCurrentDate] = useState<Date | null>(null);

  useEffect(() => {
    let midnightTimer: ReturnType<typeof setTimeout>;

    const refreshDate = () => {
      const now = new Date();
      setCurrentDate(now);
      midnightTimer = setTimeout(refreshDate, millisecondsUntilTomorrow(now) + 1000);
    };

    refreshDate();
    return () => clearTimeout(midnightTimer);
  }, []);

  return (
    <time dateTime={currentDate ? machineDate.format(currentDate) : undefined}>
      {currentDate ? displayDate.format(currentDate).toUpperCase() : "\u00a0"}
    </time>
  );
}
