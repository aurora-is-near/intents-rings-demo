import { useEffect, useMemo, useState } from 'react';
import {
  useAccount, useSignMessage, useDisconnect,
  useSendTransaction, useSwitchChain, useChainId,
} from 'wagmi';
import { base } from '@reown/appkit/networks';
import { useAppKit } from '@reown/appkit/react';
import { hexToBytes, formatEther } from 'viem';
import bs58 from 'bs58';
import { projectId } from './appkit';
import {
  fetchIntermediary, createBridgeInExecution, submitSignature, fetchExecution,
  intermediaryBalance, blockingExecution, deleteExecution, deleteMessage,
  submitDepositHash, type Intermediary,
} from './api';
import {
  checkRecipient, ringsTreeAddress, ringsProgramIds, type RecipientCheck,
} from './rings';

const DESTINATION_ASSET = 'nep141:sol.omft.near'; // native SOL
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Rings deposit discriminator — ONE byte, not Anchor's eight. Taken from the
 * SDK by building a real instruction with depositInstruction() and dumping it;
 * the Helius deposit guide documents only the SDK helper, not the wire format.
 */
const DEPOSIT_DISCRIMINATOR = '0f';

/**
 * Convert a wallet's 0x-hex `personal_sign` output into the curve-prefixed,
 * base58 form the submit endpoint wants. Submitting the raw hex is rejected:
 *
 *   400 invalid signature: signature is missing the curve prefix (want "secp256k1:")
 *
 * Layout is r(32) ‖ s(32) ‖ v(1). Only `v` is touched: wallets return 27/28 and
 * NEAR wants 0/1. r and s are left exactly as signed, and 27 is never added back.
 *
 * This is the secp256k1 branch, for an EVM origin — the backend recovers the
 * signer, so no public key is sent. An ed25519 origin (Solana, NEAR, TON) would
 * instead be `ed25519:` over 64 bytes with an explicit publicKey field.
 */
function toNearSignature(sigHex: `0x${string}`): string {
  const bytes = hexToBytes(sigHex);
  if (bytes.length !== 65) {
    throw new Error(`Expected a 65-byte signature, got ${bytes.length}.`);
  }
  const normalised = Uint8Array.from(bytes);
  if (normalised[64] >= 27) normalised[64] -= 27;
  return `secp256k1:${bs58.encode(normalised)}`;
}

/* Intents Connect covers destination gas; the user never funds the intermediary.
   The intermediary balance is displayed for information only — it is NOT a gate.
   See api.ts / createBridgeInExecution for the evidence. */
const NETWORK_FEE_LAMPORTS = 10_000;

/* Origin side: a small fixed amount of Base ETH bridged to native SOL. The
   deposit lands on the intermediary first and the network fee comes out of it.
   0.003 ETH quoted to ~0.0744 SOL on 2026-11-06. */
const ORIGIN_ASSET = 'nep141:base.omft.near';
const SWAP_AMOUNT_WEI = '3000000000000000'; // 0.003 ETH
const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Real owners in the Rings user registry, recovered from the signers of recent
 * registration transactions (the registry PDA is derived from the owner, so it
 * cannot be inverted) and each verified through resolveRegisteredAddress().
 *
 * Mainnet registration is brand new — 11 registered owners on 2026-10-30 against
 * 1,512 on devnet — so this list is short and will date quickly.
 *
 * These are other people's wallets. Nothing is sent to them here: the probe step
 * writes a memo and touches only the intermediary. Put a Rings wallet of your own
 * in before any real deposit.
 */
const RINGS_NETWORK: 'mainnet' | 'devnet' =
  typeof __RINGS_NETWORK__ === 'string' ? (__RINGS_NETWORK__ as any) : 'mainnet';

const EXAMPLES_BY_NETWORK = {
  mainnet: [
    { address: 'HTsGsb5HrJUJ23LnHZne4gG3voFRm2dCmFJZBVVQLVE1', note: 'registered — view tag f49cefbc…' },
    { address: 'CLToqXqePwjReccVwc9oLu5RRZxKZNkupsHxKTCT1y4i', note: 'registered — view tag a86ce726…' },
    { address: '6chn9n4CLhNdyBpiLLj9ouUUUmEQYBLWfpUMMuHB9K3k', note: 'registered — view tag 536fdf0e…' },
  ],
  devnet: [
    { address: 'CzbXToxdpS66CmHa3N4c2NfR4NqStAg8tGpqo6pDCprF', note: 'registered — view tag b231b338…' },
    { address: 'HHbtRXuszBYM2MeGsK569p2UTXTtfPgp4ZayCuqGJ8Vx', note: 'registered — view tag f1fbbaec…' },
    { address: '6p6aAkZpBVKGKijzFER18MaKgDKbFhEtkwNF4XJNz513', note: 'registered — view tag 565b0864…' },
  ],
} as const;

const EXAMPLE_RECIPIENTS = EXAMPLES_BY_NETWORK[RINGS_NETWORK];

type State = 'idle' | 'active' | 'done';

/* The real Aurora mark and AURORA wordmark, taken from the lockup on
   intents.aurora.dev (21px mark, 9px gap, then wordmark + "Intents" at 7px).
   Both inlined with fill="currentColor" so they take the page's ink: the live
   site ships a white-filled wordmark and corrects it with
   `filter: brightness(0)`, which only survives on a light background. */
function AuroraMark() {
  return (
    <svg className="logoMark" viewBox="0 0 512 512" fill="none" aria-hidden="true">
      <path
        d="M255.995 56C227.587 56 201.618 72.0497 188.914 97.4572L63.9181 347.461C52.2936 370.71 53.5358 398.321 67.2006 420.428C80.8653 442.535 105.003 456 131 456H381C406.997 456 431.135 442.544 444.799 420.428C458.464 398.321 459.706 370.71 448.082 347.461L323.077 97.4572C310.373 72.0497 284.404 56 255.995 56Z"
        fill="currentColor"
      />
    </svg>
  );
}

function AuroraWordmark() {
  return (
    <svg className="logoWordmark" viewBox="620 262 1175 188" fill="currentColor"
         role="img" aria-label="Aurora">
      <path d="M652.11,443.93h-24.67c-1.7,0-2.87-1.71-2.26-3.29l65.29-168.63c.54-1.4,1.89-2.32,3.39-2.32h30.87c1.5,0,2.84,.92,3.39,2.32l65.29,168.63c.61,1.59-.56,3.29-2.26,3.29h-24.67c-1.01,0-1.91-.62-2.26-1.56l-52.65-138.84c-.79-2.08-3.74-2.08-4.53,0l-52.66,138.84c-.36,.94-1.26,1.56-2.26,1.56Z" />
      <path d="M977.37,269.45c1.34,0,2.42,1.08,2.42,2.42v102.52c0,48.61-30.41,72.53-70.54,72.53s-70.54-23.93-70.54-72.53v-102.52c0-1.34,1.08-2.42,2.42-2.42h23.82c1.34,0,2.42,1.08,2.42,2.42v100.77c0,33.9,17.7,47.36,41.88,47.36s41.88-13.46,41.88-47.36v-100.77c0-1.34,1.08-2.42,2.42-2.42h23.82Z" />
      <path d="M1174.8,440.02l-48.97-62.55c27.63-5.23,43.81-23.9,43.81-52.52,0-32.86-21.41-55.26-59.24-55.26h-68.31c-2,0-3.63,1.63-3.63,3.63h0c0,12.84,10.41,23.25,23.25,23.25h45.7c22.9,0,33.85,11.7,33.85,28.63s-10.71,28.88-33.85,28.88h-65.32c-2,0-3.63,1.63-3.63,3.63v83.81c0,1.34,1.08,2.42,2.42,2.42h23.29c1.34,0,2.42-1.08,2.42-2.42v-62.55h26.88l42.52,55.49c4.58,5.98,11.68,9.48,19.21,9.48h17.69c2.02,0,3.15-2.32,1.91-3.91Z" />
      <path d="M1395.01,356.69c-.25,51.35-39.38,90.23-90.48,90.23s-90.48-38.88-90.48-90.23,39.38-90.23,90.48-90.23,90.23,38.88,90.48,90.23Zm-152.55,0c0,36.39,26.67,63.31,62.07,63.31s61.82-26.92,61.82-63.31-26.67-63.31-61.82-63.31-62.07,26.92-62.07,63.31Z" />
      <path d="M1579.7,440.02l-48.97-62.55c27.63-5.23,43.81-23.9,43.81-52.52,0-32.86-21.41-55.26-59.24-55.26h-68.31c-2,0-3.63,1.63-3.63,3.63h0c0,12.84,10.41,23.25,23.25,23.25h45.7c22.9,0,33.85,11.7,33.85,28.63s-10.71,28.88-33.85,28.88h-65.32c-2,0-3.63,1.63-3.63,3.63v83.81c0,1.34,1.08,2.42,2.42,2.42h23.29c1.34,0,2.42-1.08,2.42-2.42v-62.55h26.88l42.52,55.49c4.58,5.98,11.68,9.48,19.21,9.48h17.69c2.02,0,3.15-2.32,1.91-3.91Z" />
      <path d="M1649.05,443.93h-24.67c-1.7,0-2.87-1.71-2.26-3.29l65.29-168.63c.54-1.4,1.89-2.32,3.39-2.32h30.87c1.5,0,2.84,.92,3.39,2.32l65.29,168.63c.61,1.59-.56,3.29-2.26,3.29h-24.67c-1.01,0-1.91-.62-2.26-1.56l-52.65-138.84c-.79-2.08-3.74-2.08-4.53,0l-52.66,138.84c-.36,.94-1.26,1.56-2.26,1.56Z" />
    </svg>
  );
}

/** Copy control for the addresses a tester has to move into another window. */
function Copy({ value, label }: { value?: string; label: string }) {
  const [hit, setHit] = useState(false);
  if (!value) return null;
  return (
    <button
      className="btn-ghost btn-ghost--sm"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setHit(true); setTimeout(() => setHit(false), 1200);
        } catch { /* clipboard blocked — the address is selectable anyway */ }
      }}
    >{hit ? 'Copied' : 'Copy'}</button>
  );
}

/** One numbered row of the runbook. `do` is the tester's action, `watch` is the
    thing they should be reading while it happens. */
function Step(props: {
  n: number; state: State; title: string;
  doNow?: React.ReactNode; watch?: React.ReactNode;
  children?: React.ReactNode; status?: React.ReactNode;
}) {
  return (
    <section className="step" data-state={props.state}>
      <div className="rail">
        <div className="num">{props.state === 'done' ? '✓' : props.n}</div>
      </div>
      <div>
        <div className="stepHead">
          <h2 className="stepTitle">{props.title}</h2>
          {props.status}
        </div>
        <div className="stepBody">
          {props.doNow && (
            <div className="doNow">
              <span className="tag tag--do">Do</span>
              <div>{props.doNow}</div>
            </div>
          )}
          {props.watch && (
            <div className="watch">
              <span className="tag tag--watch">Look at</span>
              <div>{props.watch}</div>
            </div>
          )}
          {props.children}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  const { address, isConnected } = useAccount();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  const { signMessageAsync } = useSignMessage();
  const { sendTransactionAsync } = useSendTransaction();
  const { switchChainAsync } = useSwitchChain();
  const chainId = useChainId();

  const [intermediary, setIntermediary] = useState<Intermediary | null>(null);
  const [intermediaryErr, setIntermediaryErr] = useState('');
  const [balance, setBalance] = useState<number | null>(null);
  const [recipient, setRecipient] = useState('');
  const [check, setCheck] = useState<RecipientCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [execution, setExecution] = useState<any>(null);
  const [status, setStatus] = useState<string>('');
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [t0, setT0] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  // Bumped by the Retry / Check again buttons to re-run the lookups.
  const [retry, setRetry] = useState(0);
  // The execution blocking a new run (surfaced on a 409), and its cancel state.
  const [blocking, setBlocking] = useState<any>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelErr, setCancelErr] = useState<string>('');
  // The origin-chain deposit the tester sends during DEPOSIT_PENDING.
  const [depositing, setDepositing] = useState(false);
  const [depositTx, setDepositTx] = useState<string>('');
  const [depositErr, setDepositErr] = useState<string>('');
  const [depositNote, setDepositNote] = useState<string>('');

  // Resolve the intermediary as soon as a wallet connects.
  useEffect(() => {
    if (!address) { setIntermediary(null); setIntermediaryErr(''); return; }
    setIntermediaryErr('');
    fetchIntermediary(address)
      .then(setIntermediary)
      .catch(e => setIntermediaryErr(e?.message ?? String(e)));
  }, [address, retry]);

  // The intermediary must be able to pay the envelope's network fee.
  useEffect(() => {
    const addr = intermediary?.solana;
    if (!addr) { setBalance(null); return; }
    let cancelled = false;
    intermediaryBalance(addr)
      .then(b => { if (!cancelled) setBalance(b); })
      .catch(() => { if (!cancelled) setBalance(null); });
    return () => { cancelled = true; };
  }, [intermediary?.solana, retry, status]);

  // Debounced registry check.
  useEffect(() => {
    if (recipient.trim().length < 32) { setCheck(null); return; }
    let cancelled = false;
    setChecking(true);
    const id = setTimeout(async () => {
      try {
        const res = await checkRecipient(recipient.trim());
        if (!cancelled) setCheck(res);
      } catch (e: any) {
        if (!cancelled) setCheck({ registered: false, error: e.message });
      } finally {
        if (!cancelled) setChecking(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(id); };
  }, [recipient, retry]);

  // Live timer while an execution is in flight.
  useEffect(() => {
    if (t0 === null) return;
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 100);
    return () => clearInterval(id);
  }, [t0]);

  // Poll until terminal.
  useEffect(() => {
    if (!execution?.id || !address) return;
    const terminal = new Set(['SUCCESS', 'EXPIRED', 'DEPOSIT_FAILED', 'OPERATION_FAILED']);
    if (terminal.has(status)) {
      if (t0 !== null) { setTotal((Date.now() - t0) / 1000); setT0(null); }
      return;
    }
    const id = setInterval(async () => {
      const ex = await fetchExecution(address, execution.id);
      if (ex?.status) setStatus(ex.status);
      // Keep the whole row, not just the status: the deposit address and amount
      // live on `quote`, and step 4 needs them while DEPOSIT_PENDING.
      if (ex) setExecution((prev: any) => (prev?.id === ex.id ? { ...prev, ...ex } : prev));
    }, 2000);
    return () => clearInterval(id);
  }, [execution?.id, address, status, t0]);

  const settling = ['CREATED', 'DEPOSIT_PENDING', 'DEPOSIT_PROCESSING'].includes(status);
  const operating = ['OPERATION_PENDING', 'OPERATION_PROCESSING'].includes(status);
  const done = status === 'SUCCESS';
  const failed = status.includes('FAILED') || status === 'EXPIRED';

  /**
   * Everything still standing between here and a run, in the order a tester
   * should fix it. Step 2 deliberately works without a wallet — the registry is
   * a public read — so a tester can finish it and still be blocked by step 1.
   * That has to be said explicitly: "finish steps 1 and 2" reads as broken when
   * step 2 is visibly done.
   */
  const blockers = useMemo(() => {
    const out: string[] = [];
    if (!isConnected) out.push('connect your wallet in step 1');
    else if (!intermediary) out.push('wait for the intermediary address to resolve in step 1');
    if (!check?.registered) out.push('enter a registered recipient in step 2');
    return out;
  }, [isConnected, intermediary, check?.registered]);

  const st = useMemo(() => ({
    connect:   (isConnected && intermediary ? 'done' : 'active') as State,
    // The registry is a public read, so this can be completed before the wallet
    // is connected. If it has been, say so rather than showing it as not begun.
    recipient: (check?.registered ? 'done' : !isConnected ? 'idle' : 'active') as State,
    // Only 'active' once the run can actually start. Keying this off the
    // registry alone made the step look ready while the button stayed disabled.
    sign:      (!isConnected || !intermediary || !check?.registered ? 'idle'
                 : signed ? 'done' : 'active') as State,
    settle:    (!signed ? 'idle' : (operating || done) ? 'done' : 'active') as State,
    deposit:   (!(operating || done) ? 'idle' : done ? 'done' : 'active') as State,
    decrypt:   (done ? 'done' : 'idle') as State,
  }), [isConnected, intermediary, check, signed, operating, done]);

  /** Look up whichever execution is holding the wallet open. */
  async function findBlocking() {
    if (!address) return null;
    setCancelErr('');
    try {
      const row = await blockingExecution(address);
      setBlocking(row);
      return row;
    } catch (e: any) {
      setCancelErr(e.message ?? String(e));
      return null;
    }
  }

  /**
   * Cancel the blocking execution. Needs a second personal_sign, over the
   * literal `delete_execution:<id>` — the same encoding as a submit signature.
   */
  async function cancelBlocking() {
    if (!address || !blocking?.id) return;
    setCancelErr(''); setCancelling(true);
    try {
      const signature = await signMessageAsync({ message: deleteMessage(blocking.id) });
      await deleteExecution(address, blocking.id, toNearSignature(signature));
      setBlocking(null);
      // The wallet is free again, so clear the 409 that surfaced this panel.
      setError('');
      setExecution(null); setStatus(''); setSigned(false);
    } catch (e: any) {
      setCancelErr(e.message ?? String(e));
      // Re-read: it may have been deleted or moved on under us.
      await findBlocking();
    } finally {
      setCancelling(false);
    }
  }

  /**
   * Send the origin-chain deposit from the tester's own wallet.
   *
   * During DEPOSIT_PENDING the execution is waiting on `quote.amountIn` arriving
   * at `quote.depositAddress`. The origin asset here is native Base ETH, so this
   * is a plain value transfer — no token approval, no contract call.
   */
  async function sendDeposit() {
    const q = execution?.quote;
    if (!address || !q?.depositAddress || !q?.amountIn) return;
    setDepositErr(''); setDepositNote(''); setDepositing(true);
    try {
      // The deposit must land on the ORIGIN chain. A wallet left on another
      // network would otherwise send real funds to the right address on the
      // wrong chain, which is unrecoverable through this flow.
      if (chainId !== base.id) {
        await switchChainAsync({ chainId: base.id });
      }
      const hash = await sendTransactionAsync({
        to: q.depositAddress as `0x${string}`,
        value: BigInt(q.amountIn),
        chainId: base.id,
      });
      setDepositTx(hash);

      // Non-fatal: the funds are already gone, so a failure here is a detection
      // delay, not a lost deposit.
      try {
        await submitDepositHash(hash, q.depositAddress, q.depositMemo);
      } catch (e: any) {
        setDepositNote(`Deposit sent, but the hash could not be reported (${e.message ?? e}). `
          + 'The backend watches the address, so it should still be detected.');
      }
    } catch (e: any) {
      setDepositErr(e.shortMessage ?? e.message ?? String(e));
    } finally {
      setDepositing(false);
    }
  }

  async function run() {
    if (!address) return;
    setError(''); setBusy(true); setStatus(''); setSigned(false);
    setTotal(null); setT0(Date.now()); setElapsed(0);
    setBlocking(null); setCancelErr('');
    setDepositTx(''); setDepositErr(''); setDepositNote('');
    try {
      if (!check?.viewTagB58 || !check?.ownerHashB58) {
        throw new Error('The recipient’s view tag and owner hash are not resolved yet.');
      }

      // The real Rings deposit. Layout taken from the SDK (78 bytes, one-byte
      // discriminator 0x0f), with every field expressed as a step arg:
      //
      //   0f | assetsLen | assetKind | depositsLen | assetIndex
      //      | viewTag(32) | ownerHash(32) | amount(u64 LE) | memoOption
      //
      // The two 32-byte hashes ride as `pubkey`, NOT `bytes`: the encoder
      // length-prefixes a bytes arg (proven on mainnet — a 21-byte payload
      // arrived as 25), which would corrupt this fixed-width layout. A pubkey
      // is fixed width and appended raw.
      //
      // Issued as a BRIDGE-IN: the deposit delivers SOL to the intermediary
      // first and the network fee is quoted into the operation, so nothing has
      // to be pre-funded. Steps-only assumes funds are already there.
      const [tree, ids] = await Promise.all([ringsTreeAddress(), ringsProgramIds()]);

      const created = await createBridgeInExecution(
        address,
        [{
          programId: ids.pool,
          discriminator: DEPOSIT_DISCRIMINATOR,
          accounts: [
            { pubkey: tree, isSigner: false, isWritable: true },
            { pubkey: '{INTERMEDIARY}', isSigner: true, isWritable: true },
            { pubkey: ids.pool, isSigner: false, isWritable: false },
            { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
            { pubkey: ids.solInterface, isSigner: false, isWritable: true },
          ],
          args: [
            { name: 'assetsLen', type: 'u8', value: '1' },
            { name: 'assetKind', type: 'u8', value: '0' },   // 0 = SOL
            { name: 'depositsLen', type: 'u8', value: '1' },
            { name: 'assetIndex', type: 'u8', value: '0' },
            { name: 'viewTag', type: 'pubkey', value: check.viewTagB58 },
            { name: 'ownerHash', type: 'pubkey', value: check.ownerHashB58 },
            // The post-fee bridged amount, substituted by the service. Any
            // surplus over the minimum stays in the intermediary, which the
            // tester owns.
            { name: 'amount', type: 'u64', value: '{MIN_AMOUNT_OUT}' },
            { name: 'memoNone', type: 'u8', value: '0' },    // Option::None
          ],
          metadata: { name: 'rings-deposit' },
        }],
        {
          originAsset: ORIGIN_ASSET,
          destinationAsset: DESTINATION_ASSET,
          amount: SWAP_AMOUNT_WEI,
          refundTo: address,
        },
      );

      setExecution(created);
      setStatus(created.status ?? 'CREATED');

      const message = created.details?.messageToSign;
      if (!message) throw new Error('No messageToSign returned — cannot continue.');

      // EVM origin -> erc191 (personal_sign), exactly what wagmi does here.
      const signature = await signMessageAsync({ message });
      await submitSignature(address, created.id, toNearSignature(signature));
      setSigned(true);
    } catch (e: any) {
      const msg = e.message ?? String(e);
      setError(msg);
      setT0(null);
      // A 409 is recoverable: find the row holding the wallet so it can be
      // cancelled from here instead of leaving the tester stuck.
      if (/already in progress/i.test(msg)) await findBlocking();
    } finally {
      setBusy(false);
    }
  }

  /* No funding precondition: bridge-in delivers the destination token before the
     steps run, and the network fee is quoted into the operation. */
  const canRun = isConnected && !!intermediary && check?.registered && !busy;

  /* Past CREATED, a deposit may already have arrived — and the docs do not say
     what deleting the row does to it. Warn rather than guess. */
  const depositMayHaveLanded = !!blocking && blocking.status !== 'CREATED';

  /* The deposit the tester owes while the execution waits for it. `amountIn` is
     wei of the origin asset (native Base ETH), so it is formatted for display
     but always SENT as the exact integer — never the rounded value. */
  const deposit = execution?.quote;
  const awaitingDeposit =
    !!deposit?.depositAddress && !!deposit?.amountIn && !depositTx &&
    ['CREATED', 'DEPOSIT_PENDING'].includes(status);
  const depositEth = deposit?.amountIn
    ? formatEther(BigInt(deposit.amountIn))
    : '';
  const wrongChain = isConnected && chainId !== base.id;
  const live = (s: State) => s === 'active' && t0 !== null
    ? <span className="timer">{elapsed.toFixed(1)}s</span> : null;

  return (
    <div className="page">
      <div className="topbar">
        <a className="brand" href="https://intents.aurora.dev/" target="_blank" rel="noreferrer">
          <AuroraMark />
          <span className="brandWm">
            <AuroraWordmark />
            <span className="brandName">Intents</span>
          </span>
        </a>
        {/* Reown AppKit drives the connection; the control is ours so it stays
            on-system — a flat ink fill, never AppKit blue. Lime is reserved for
            the one primary action per step. */}
        {!projectId ? (
          <span className="chip chip--amber">Set VITE_REOWN_PROJECT_ID</span>
        ) : isConnected ? (
          <div className="row">
            <button className="walletChip" onClick={() => open()} title={address}>
              <span className="dot" />
              {address?.slice(0, 6)}…{address?.slice(-4)}
            </button>
            <button className="linkBtn" onClick={() => disconnect()}>Disconnect</button>
          </div>
        ) : (
          <button className="connectCta" onClick={() => open()}>Connect wallet</button>
        )}
      </div>

      <header className="intro">
        {/* The site's one repeating signature: a mono, wide-tracked label. */}
        <p className="lab">Prototype · Aurora Intents × Helius Rings</p>
        <h1>Swap output delivered into a confidential Rings balance</h1>
        <p>
          A tester swaps from an EVM wallet on Base. Instead of landing in the recipient’s
          public Solana account, the output is deposited into their Helius Rings
          <em> confidential</em> balance — signed on Solana by an Intents Connect
          intermediary account through NEAR Chain Signatures. The recipient keeps one
          ordinary address.
        </p>
        <p className="hint">
          What this prototype is for: proving the two legs join at the intermediary, and
          measuring how long each leg takes.{' '}
          {RINGS_NETWORK === 'mainnet' ? (
            <>Rings went live on mainnet on 30 Oct 2026, so <strong>both legs now run on
            mainnet</strong> — the cross-cluster seam this prototype was originally designed
            around is gone. Registration there is new, so few wallets are registered yet.</>
          ) : (
            <>The Rings leg is pinned to devnet and the Intents leg runs on mainnet; they meet
            at the same ed25519 address, which exists on both.</>
          )}{' '}
          Follow the steps below in order; each one tells you what to watch.
        </p>
        <p className="hint" style={{
          borderLeft: '2px solid var(--lime)', paddingLeft: 'var(--sp-4)', color: 'var(--ink)',
        }}>
          <strong>This is the whole flow, end to end.</strong> The step submitted on Solana is
          the real Rings deposit — one-byte discriminator <code>0f</code>, the recipient’s view
          tag and owner hash read from the on-chain registry in step 2, and the bridged amount
          substituted by the service. A successful run leaves a <em>confidential</em> balance
          the recipient alone can read.
        </p>
      </header>

      <div className="steps">
        <Step n={1} state={st.connect} title="Connect the origin wallet"
          status={st.connect === 'done' ? <span className="chip chip--green">Connected</span> : undefined}
          doNow={
            !projectId ? <>Set <code>VITE_REOWN_PROJECT_ID</code> in <code>demo/.env</code>, then reload.</>
            : !isConnected ? (
              <div className="actions">
                <button className="btn-primary" onClick={() => open()}>Connect wallet</button>
                <span className="hint">Any EVM wallet on Base.</span>
              </div>
            ) : (
              <div className="actions">
                <button className="btn-ghost" onClick={() => open()}>Change wallet</button>
                <button className="btn-ghost" onClick={() => disconnect()}>Disconnect</button>
                {intermediaryErr && (
                  <button className="btn-ghost" onClick={() => setRetry(n => n + 1)}>Retry</button>
                )}
              </div>
            )
          }
          watch={<>The <strong>intermediary Solana address</strong> that appears below. It is
                  derived from your EVM address — you never create or fund it.</>}
        >
          {isConnected && (
            <div className="readout">
              <div className="kv">
                <span>Origin wallet</span>
                <span className="addr">{address} <Copy value={address} label="origin wallet" /></span>
              </div>
              <div className="kv">
                <span>Intermediary (Solana)</span>
                <span className="addr">
                  {intermediary?.solana ?? (intermediaryErr ? 'unavailable' : 'resolving…')}
                  {' '}<Copy value={intermediary?.solana} label="intermediary address" />
                </span>
              </div>
              {intermediary?.solana && (
                <div className="kv">
                  <span>Its SOL balance (mainnet)</span>
                  <span className="addr">
                    {balance === null ? 'checking…' : `${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`}
                    {' '}<span className="chip">informational</span>
                  </span>
                </div>
              )}
            </div>
          )}
          {intermediary?.solana && (
            <p className="hint">
              You do not need to fund this account. Intents Connect covers destination gas —
              <em> “destination gas remains an Intents Connect execution responsibility, not a
              user prerequisite.”</em> The run bridges in first, so the
              {' '}{NETWORK_FEE_LAMPORTS.toLocaleString()}-lamport network fee is paid out of
              what the deposit delivers. The balance above is shown only so you can watch the
              deposit arrive.
            </p>
          )}
          {intermediaryErr && (
            <>
              <p className="err">Could not resolve the intermediary: {intermediaryErr}</p>
              <p className="hint">
                A 431 here means the browser sent too many localhost cookies upstream.
                The dev proxy now strips them — restart the dev server if you still see it.
              </p>
            </>
          )}
        </Step>

        <Step n={2} state={st.recipient} title="Enter the recipient’s Solana address"
          status={
            checking ? <span className="chip">Checking registry</span>
            : check?.registered ? <span className="chip chip--green">Can receive confidentially</span>
            : check ? <span className="chip chip--amber">Not registered</span> : undefined}
          doNow={<>
            Paste an ordinary Solana wallet address. It must already be registered in the
            Rings user registry on {RINGS_NETWORK}.
            <div className="actions" style={{ marginTop: 'var(--sp-3)' }}>
              <button className="btn-ghost" onClick={async () => {
                try { setRecipient((await navigator.clipboard.readText()).trim()); }
                catch { /* clipboard read denied — type it instead */ }
              }}>Paste from clipboard</button>
              {recipient && (
                <button className="btn-ghost" onClick={() => { setRecipient(''); setCheck(null); }}>
                  Clear
                </button>
              )}
              {check && !checking && (
                <button className="btn-ghost" onClick={() => setRetry(n => n + 1)}>Check again</button>
              )}
            </div>
            <p className="hint" style={{ marginTop: 'var(--sp-4)' }}>
              No Rings wallet to hand? These are real registered owners on {RINGS_NETWORK} — click one:
            </p>
            <div className="exampleRow">
              {EXAMPLE_RECIPIENTS.map(e => (
                <button key={e.address} className="example" onClick={() => setRecipient(e.address)}>
                  {e.address}
                  <span className="muted"> · {e.note}</span>
                </button>
              ))}
              {intermediary?.solana && (
                <button className="example" onClick={() => setRecipient(intermediary.solana)}>
                  {intermediary.solana}
                  <span className="muted"> · not registered — shows the fallback</span>
                </button>
              )}
            </div>
          </>}
          watch={<>The <strong>view tag</strong> and <strong>owner hash</strong> resolved from the
                   on-chain registry. These are what let the sender address a confidential
                   deposit without ever learning the recipient’s keys.</>}
        >
          <input
            id="recipient" className="field" spellCheck={false}
            placeholder="Recipient’s Solana address"
            value={recipient} onChange={e => setRecipient(e.target.value)}
          />
          {check?.registered && (
            <div className="readout">
              <div className="kv">
                <span>View tag</span>
                <span className="addr">{check.viewTag} <Copy value={check.viewTag} label="view tag" /></span>
              </div>
              <div className="kv">
                <span>Owner hash</span>
                <span className="addr">{check.ownerHash} <Copy value={check.ownerHash} label="owner hash" /></span>
              </div>
            </div>
          )}
          {check && !check.registered && !checking && (
            <p className="hint">
              Not in the registry, so only a public transfer is possible. Register this
              wallet in Rings on {RINGS_NETWORK}, or try a different address.
            </p>
          )}
          {check?.error && <p className="err">{check.error}</p>}
        </Step>

        <Step n={3} state={st.sign} title="Sign once, on Base"
          status={live(st.sign)}
          doNow={<>Press <strong>Start the run</strong> and approve the signature in your
                   wallet. This is the only signature you give — one
                   <code> personal_sign</code> on the origin chain. It authorises the whole
                   flow, including the Solana deposit you never sign for.</>}
          watch={<>No Solana transaction is signed by you. The deposit is co-signed by the
                   NEAR MPC on behalf of the intermediary, using its ed25519 key. That is
                   what lets a swap land in someone’s confidential balance without the
                   sender ever holding a Solana key.</>}
        >
          <div className="row">
            <button className="btn-primary" onClick={run} disabled={!canRun}>
              {busy ? 'Waiting for signature…' : 'Start the run'}
            </button>
            {execution?.id && (
              <span className="mono muted">
                {execution.id} <Copy value={execution.id} label="execution id" />
              </span>
            )}
          </div>
          {!canRun && !busy && blockers.length > 0 && (
            <>
              <p className="hint">
                To start the run, {blockers.join(', and ')}.
              </p>
              {/* The wallet is the one blocker a tester can clear from here, so
                  offer it inline rather than sending them back up the page. */}
              {!isConnected && projectId && (
                <div className="actions">
                  <button className="connectCta" onClick={() => open()}>Connect wallet</button>
                </div>
              )}
            </>
          )}
          {error && (
            <>
              <p className="err">{error}</p>
              <div className="actions">
                <button className="btn-ghost" onClick={run} disabled={!canRun || busy}>Try again</button>
              </div>
            </>
          )}

          {/* A 409 means an earlier execution is still open and must be cleared
              before a new one can start. The API does not say which row it
              collided with, so it is looked up and shown before anything is
              deleted — never cancel blind. */}
          {blocking && (
            <div className="readout">
              <div className="kv">
                <span>Blocking execution</span>
                <span className="addr">
                  {blocking.id} <Copy value={blocking.id} label="execution id" />
                </span>
              </div>
              <div className="kv">
                <span>Status</span>
                <span className="addr">{blocking.status}</span>
              </div>
              {blocking.createdAt && (
                <div className="kv">
                  <span>Created</span>
                  <span className="addr">{blocking.createdAt}</span>
                </div>
              )}
              <p className="hint" style={{ marginTop: 'var(--sp-3)' }}>
                Cancelling asks your wallet for a second signature, over{' '}
                <code>delete_execution:{blocking.id.slice(0, 8)}…</code>. Only you can do it —
                the backend recovers the signer and checks it against your address.
              </p>
              {depositMayHaveLanded && (
                <p className="hint" style={{
                  borderLeft: '2px solid var(--warn)', paddingLeft: 'var(--sp-4)',
                  color: 'var(--ink)',
                }}>
                  <strong>Check before you cancel.</strong> This execution is past{' '}
                  <code>CREATED</code>, so a deposit may already have arrived. The API docs do
                  not say what happens to deposited funds when a row is deleted. The
                  intermediary is yours either way, but confirm with the Aurora team rather
                  than assuming the funds follow.
                </p>
              )}
              <div className="actions">
                <button className="btn-ghost" onClick={cancelBlocking} disabled={cancelling}>
                  {cancelling ? 'Waiting for signature…' : 'Cancel this execution'}
                </button>
                <button className="btn-ghost" onClick={findBlocking} disabled={cancelling}>
                  Refresh
                </button>
              </div>
              {cancelErr && <p className="err">{cancelErr}</p>}
            </div>
          )}
        </Step>

        <Step n={4} state={st.settle} title="Send the deposit, then NEAR Intents settles on Solana"
          status={<>
            {settling && <span className="chip chip--lime">{status.replace(/_/g, ' ').toLowerCase()}</span>}
            {live(st.settle)}
          </>}
          doNow={awaitingDeposit
            ? <>Press <strong>Send the deposit</strong>. This is the one transaction you pay
                for — {depositEth} ETH on Base, from your wallet to the execution’s deposit
                address. Nothing moves until it lands.</>
            : depositTx
              ? <>Nothing to do — the deposit has been sent and the solver takes it from here.</>
              : <>Once the run starts, the deposit address appears here and you send
                 {' '}{formatEther(BigInt(SWAP_AMOUNT_WEI))} ETH on Base to it.</>}
          watch={<>The status moving <code>CREATED → DEPOSIT_PENDING → DEPOSIT_PROCESSING</code>.
                   The swap output arrives at the intermediary account. This is the leg whose
                   duration depends on the solver, not on us.</>}
        >
          {awaitingDeposit && (
            <div className="readout">
              <div className="kv">
                <span>Send exactly</span>
                <span className="addr">
                  {depositEth} ETH <span className="muted">({deposit.amountIn} wei)</span>
                </span>
              </div>
              <div className="kv">
                <span>To (on Base)</span>
                <span className="addr">
                  {deposit.depositAddress} <Copy value={deposit.depositAddress} label="deposit address" />
                </span>
              </div>
              {deposit.deadline && (
                <div className="kv">
                  <span>Quote expires</span>
                  <span className="addr">{deposit.deadline}</span>
                </div>
              )}
              {deposit.depositMemo && (
                <div className="kv">
                  <span>Memo</span>
                  <span className="addr">{deposit.depositMemo}</span>
                </div>
              )}
              <div className="actions" style={{ marginTop: 'var(--sp-4)' }}>
                <button className="btn-primary" onClick={sendDeposit} disabled={depositing}>
                  {depositing ? 'Confirm in your wallet…' : `Send the deposit — ${depositEth} ETH`}
                </button>
                {wrongChain && <span className="chip chip--amber">Will switch to Base first</span>}
              </div>
              <p className="hint">
                This spends real funds. The quote has a deadline — if it passes before the
                deposit lands, the execution expires and the amount is refunded to your
                address rather than swapped.
              </p>
            </div>
          )}
          {depositTx && (
            <div className="readout">
              <div className="kv">
                <span>Deposit sent</span>
                <span className="addr">
                  {depositTx} <Copy value={depositTx} label="deposit tx hash" />
                </span>
              </div>
              <p className="hint">
                <a href={`https://basescan.org/tx/${depositTx}`} target="_blank" rel="noreferrer">
                  View on Basescan
                </a>{' '}— the status above moves on once the deposit is detected.
              </p>
            </div>
          )}
          {depositNote && <p className="hint">{depositNote}</p>}
          {depositErr && (
            <>
              <p className="err">{depositErr}</p>
              <div className="actions">
                <button className="btn-ghost" onClick={sendDeposit} disabled={depositing}>
                  Try the deposit again
                </button>
              </div>
            </>
          )}
        </Step>

        <Step n={5} state={st.deposit} title="The intermediary deposits into Rings"
          status={<>
            {operating && <span className="chip chip--lime">{status.replace(/_/g, ' ').toLowerCase()}</span>}
            {live(st.deposit)}
          </>}
          watch={<><code>OPERATION_PENDING → OPERATION_PROCESSING</code>. Intents Connect builds
                   the Solana transaction, the NEAR MPC co-signs it with the intermediary’s
                   ed25519 key, and it lands on {RINGS_NETWORK}. The deposit is the 78-byte
                   Rings instruction — discriminator <code>0f</code>, the view tag and owner
                   hash from step 2, and the bridged amount. A single SOL deposit measured
                   26,682 of 200,000 CU and 498 of 1,232 bytes, so there is room to spare.</>}
        />

        <Step n={6} state={st.decrypt} title="The recipient sees a confidential balance"
          status={<>
            {done && <span className="chip chip--green">delivered</span>}
            {failed && <span className="chip chip--fail">{status.replace(/_/g, ' ').toLowerCase()}</span>}
          </>}
          watch={<>The recipient’s own wallet decrypts the new balance with its viewing key.
                   Nobody else can read the amount — only that a deposit happened. The
                   recipient did nothing here and holds one ordinary Solana address; what
                   arrived is confidential from the moment it lands.</>}
        >
          {(done || failed) && (
            <div className="actions">
              <button className="btn-primary" onClick={run} disabled={!canRun}>Run it again</button>
              <button className="btn-ghost" onClick={() => {
                setExecution(null); setStatus(''); setSigned(false);
                setError(''); setT0(null); setElapsed(0); setTotal(null);
                setDepositTx(''); setDepositErr(''); setDepositNote('');
              }}>Reset the run</button>
            </div>
          )}
          {total !== null && (
            <div className="readout">
              <div className="kv"><span>End to end</span><span className="addr">{total.toFixed(1)}s</span></div>
              <div className="kv"><span>Final status</span><span className="addr">{status}</span></div>
            </div>
          )}
        </Step>
      </div>

      <section style={{ marginTop: 'var(--sp-10)' }}>
        <p className="lab" style={{ marginBottom: 'var(--sp-3)' }}>Privacy model</p>
        <h2 className="stepTitle" style={{ marginBottom: 'var(--sp-4)' }}>What stays visible</h2>
        <table className="vis">
          <thead>
            <tr><th>Stage</th><th>Visible onchain</th><th>Confidential</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Settlement to the intermediary</td>
              <td>Asset, amount, intermediary address</td>
              <td>Nothing</td>
            </tr>
            <tr>
              <td>Rings deposit</td>
              <td>Depositor, recipient, asset, amount</td>
              <td>The resulting balance</td>
            </tr>
            <tr>
              <td>After the deposit</td>
              <td>Sender and recipient of Rings transfers</td>
              <td>Asset, amount, memo</td>
            </tr>
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 'var(--sp-4)' }}>
          The delivery itself is a public deposit. What becomes confidential is the balance
          and everything the recipient does with it afterwards.
        </p>
      </section>

      <p className="footerNote">
        Built by <a href="https://aurora.dev">Aurora</a> on{' '}
        <a href="https://near-intents.org">NEAR Intents</a>. Rings by{' '}
        <a href="https://helius.dev">Helius</a>. Prototype — not for production use.
      </p>
    </div>
  );
}
