// Server re-export of the client-safe token-plan math (`$lib/consumer/plan`).
// Kept so server modules + the plan.test.ts contract import from
// `$lib/server/consumer/plan` while the runtime lives outside `$lib/server`
// (SvelteKit forbids `$lib/server/*` in browser code; the role editor + My-Account
// import the client module directly).
export { planToCap, capToPlan, chatsLeft } from '$lib/consumer/plan';
