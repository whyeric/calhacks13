/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as alerts from "../alerts.js";
import type * as auth from "../auth.js";
import type * as calls from "../calls.js";
import type * as catalog from "../catalog.js";
import type * as checkins from "../checkins.js";
import type * as companion from "../companion.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as favoriteSuggestions from "../favoriteSuggestions.js";
import type * as households from "../households.js";
import type * as http from "../http.js";
import type * as memory from "../memory.js";
import type * as memoryRules from "../memoryRules.js";
import type * as orderStatus from "../orderStatus.js";
import type * as orders from "../orders.js";
import type * as payments from "../payments.js";
import type * as pin from "../pin.js";
import type * as scam from "../scam.js";
import type * as seed from "../seed.js";
import type * as visaRail from "../visaRail.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  alerts: typeof alerts;
  auth: typeof auth;
  calls: typeof calls;
  catalog: typeof catalog;
  checkins: typeof checkins;
  companion: typeof companion;
  crons: typeof crons;
  dashboard: typeof dashboard;
  favoriteSuggestions: typeof favoriteSuggestions;
  households: typeof households;
  http: typeof http;
  memory: typeof memory;
  memoryRules: typeof memoryRules;
  orderStatus: typeof orderStatus;
  orders: typeof orders;
  payments: typeof payments;
  pin: typeof pin;
  scam: typeof scam;
  seed: typeof seed;
  visaRail: typeof visaRail;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
