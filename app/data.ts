export const todayData = {
  priorities: [
    { name: "Elena & David Chen", initials: "EC", color: "#d9e8df", label: "High momentum", signal: "warm", reason: "Meeting today at 2:00 PM", why: "Opened your last three updates and recently attended the scholarship reception.", action: "Prepare", href: "/donors/elena-chen" },
    { name: "Marcus Williams", initials: "MW", color: "#e6ddcf", label: "Time sensitive", signal: "urgent", reason: "Thank-you due today", why: "Made a $10,000 gift 42 hours ago. Personal outreach performs best within 48 hours.", action: "Thank Marcus", href: "/assistant" },
    { name: "Priya & Arun Mehta", initials: "PM", color: "#e5e0eb", label: "Re-engage", signal: "steady", reason: "No contact in 94 days", why: "Their daughter’s program begins next week—a natural reason to reconnect.", action: "Reach out", href: "/assistant" },
    { name: "James Holloway", initials: "JH", color: "#dce5e8", label: "Follow up", signal: "steady", reason: "Follow-up from Tuesday’s call", why: "Asked for the impact brief and indicated interest in a fall site visit.", action: "Send brief", href: "/assistant" },
  ],
  meetings: [
    { time: "10:30", period: "AM", title: "Weekly development sync", detail: "Conference Room B", prep: false },
    { time: "2:00", period: "PM", title: "Elena & David Chen", detail: "The Garden Room · 45 min", prep: true },
    { time: "4:30", period: "PM", title: "President’s cabinet prep", detail: "Zoom · 30 min", prep: false },
  ],
  gifts: [
    { name: "Marcus Williams", initials: "MW", color: "#e6ddcf", detail: "Annual Fund · 2h ago", amount: "$10,000" },
    { name: "Lucy Brennan", initials: "LB", color: "#e3e7dc", detail: "Scholarship Fund · 5h ago", amount: "$2,500" },
  ],
};

export const donor = {
  name: "Elena & David Chen",
  location: "Boston, MA · Partners since 2018",
  summary:
    "Elena and David care deeply about first-generation student access, shaped by Elena’s own path through higher education. Their relationship has grown steadily through scholarship events and personal conversations with students. They respond best to warm, specific updates and prefer substance over ceremony.",
  nextAction:
    "Use today’s meeting to share Maya Rodriguez’s first-semester update, then ask how they would like to stay connected as the scholarship program grows.",
  timeline: [
    { date: "JUL 28", title: "Opened scholarship impact update", body: "Read for 4 minutes and returned to the student story twice." },
    { date: "JUN 12", title: "Attended scholarship reception", body: "Spoke with Maya Rodriguez and asked about her research plans." },
    { date: "MAY 04", title: "Personal note from Elena", body: "Shared that their 30th anniversary is August 3." },
    { date: "MAR 18", title: "Gift received · $25,000", body: "Renewed their annual scholarship support for a third year." },
  ],
};
