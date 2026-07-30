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
  code: "DON-00428",
  name: "Elena & David Chen",
  location: "Cambridge, MA",
  email: "elena.chen@example.org",
  phone: "(617) 555-0148",
  lifetimeGiving: "$112,500",
  summary:
    "Elena and David are deeply committed to first-generation student access, shaped by Elena’s own scholarship experience. Their giving has been consistent, and recent engagement suggests increasing interest in the students behind the program—not just the program itself. They respond best to warm, specific updates and prefer substance over ceremony.",
  nextAction:
    "Share Maya Rodriguez’s first-semester update, then ask how they would like to stay connected as the scholarship program grows. Do not lead with a new funding request.",
  memory: [
    { icon: "♡", label: "Personal context", body: "Elena attended college on scholarship. Their daughter Lily graduated from the university in 2016.", source: "From 3 conversations · Last confirmed May 4" },
    { icon: "◇", label: "Recognition preference", body: "They value private thanks and student updates; they have declined public naming opportunities twice.", source: "Stewardship notes · Confirmed Mar 2025" },
    { icon: "◌", label: "Relationship nuance", body: "David is analytical and asks about outcomes. Elena connects through individual student stories and often drives follow-up.", source: "Team observation · Added by Sarah Mitchell" },
    { icon: "□", label: "Upcoming moment", body: "Their 30th anniversary is August 3. A handwritten note would feel timely and personal.", source: "Personal note from Elena · May 4" },
  ],
  timeline: [
    { date: "JUL 28", year: "2026", icon: "↗", type: "digital", label: "ENGAGEMENT", title: "Returned to Maya’s scholarship story", body: "Elena opened the impact update twice and spent four minutes with the student story.", insight: "Strongest digital engagement in the last six months." },
    { date: "JUN 12", year: "2026", icon: "○", type: "meeting", label: "IN PERSON", title: "Built a personal connection at the scholarship reception", body: "Elena and David spent 20 minutes with Maya Rodriguez and asked about her research plans.", insight: "David requested a follow-up on program outcomes." },
    { date: "MAY 04", year: "2026", icon: "✉", type: "note", label: "PERSONAL NOTE", title: "Elena shared an important family milestone", body: "Her note mentioned that she and David will celebrate their 30th anniversary on August 3.", insight: null },
    { date: "MAR 18", year: "2026", icon: "◇", type: "gift", label: "GIFT", title: "Renewed scholarship support · $25,000", body: "Third consecutive year at this level, bringing lifetime giving to $112,500.", insight: "Acknowledged personally by Sarah the following day." },
  ],
};
