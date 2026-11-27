// Runs once when the Next.js server starts (not during `next build`).
// The import must sit inside this check so it is left out of the edge-runtime bundle.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startLeadAutoSync } = await import('./services/autoSync');
    startLeadAutoSync();
  }
}
