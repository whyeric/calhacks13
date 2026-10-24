import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// #60: place scheduled check-in calls that are due (per-household cadence in checkin_settings).
crons.interval("check-in calls", { hours: 1 }, internal.checkins.tick, {});

export default crons;
