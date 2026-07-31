"use client";

import { useEffect, useState } from "react";

export function LocalDate({ timezone }: { timezone: string }) {
  const [currentDate, setCurrentDate] = useState<Date | null>(null);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout>;

    const refreshDate = () => {
      const now = new Date();
      setCurrentDate(now);
      refreshTimer = setTimeout(refreshDate, 60 * 60 * 1000);
    };

    refreshDate();
    return () => clearTimeout(refreshTimer);
  }, []);

  return (
    <time
      dateTime={currentDate ? new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(currentDate) : undefined}
      suppressHydrationWarning
    >
      {currentDate ? new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" }).format(currentDate).toUpperCase() : "\u00a0"}
    </time>
  );
}
