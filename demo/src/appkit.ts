import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { base, mainnet, arbitrum, optimism } from '@reown/appkit/networks';

export const projectId = import.meta.env.VITE_REOWN_PROJECT_ID as string;

/** Base first — the origin chain for this prototype. */
export const networks = [base, mainnet, arbitrum, optimism] as const;

export const wagmiAdapter = new WagmiAdapter({
  projectId,
  networks: [...networks],
  ssr: false,
});

export function initAppKit() {
  if (!projectId) return;
  createAppKit({
    adapters: [wagmiAdapter],
    projectId,
    networks: [...networks],
    defaultNetwork: base,
    metadata: {
      name: 'Aurora Intents × Rings',
      description: 'Confidential delivery to a Solana Rings balance, from any chain',
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.svg`],
    },
    features: { analytics: false, email: false, socials: false },
    // Matched to the live intents.aurora.dev palette (read 2026-11-04): light
    // canvas, lime #ceec98, ink #14161b, Onest. The previous values here were
    // from the stale Oct-2026 dark export and clashed with the page.
    themeMode: 'light',
    themeVariables: {
      '--w3m-accent': '#ceec98',
      '--w3m-color-mix': '#14161b',
      '--w3m-border-radius-master': '2px',
      '--w3m-font-family': "'Onest', system-ui, sans-serif",
    },
  });
}
