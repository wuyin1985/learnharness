"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { CLAUDE_CODE_PROVIDER, sessionCacheHitRate, subscriptionLabels, subscriptionLabel, type cliContextWindowOf, type SessionPricing, type TurnUsage } from "@/src/core";
import { formatTokens, formatUsd, planCostLabel, prettyModel } from "@/components/usage-format";
import { ModelControl, catalogLimits, useModelCatalog } from "@/components/model-picker";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { AndroidActions } from "@/components/android-actions";
import { useAndroidLayout } from "@/components/android-layout";
import { AttachFilesButton } from "@/components/attach-files-button";

export function formatContextMeasurement(tokens: number | null, limit: number | null): string {
	const numerator = tokens === null ? "?" : formatTokens(tokens);
	return limit === null ? numerator : `${numerator} / ${formatTokens(limit)}`;
}

/** CLI aliases have no global catalog limit: only this session's matching
 * response can supply a denominator. Other providers keep their catalog join. */
export function contextLimitForModel(model: string | undefined, limits: ReadonlyMap<string, number> | undefined,
	cliWindow: ReturnType<typeof cliContextWindowOf> = null): number | null {
	if (!model) return null;
	if (model.startsWith(`${CLAUDE_CODE_PROVIDER}:`)) return cliWindow?.model === model ? cliWindow.tokens : null;
	return limits?.get(model) ?? null;
}

/**
 * The below-composer stats bar (wave 4 observability): the session's
 * money/context footprint as one quiet row beneath the composer —
 * LEFT-aligned: context window + session cost; RIGHT-aligned: model +
 * thinking level. Clicking the left side opens the per-turn detail popover.
 *
 *  Pre-chat views (home, /chat/new) render NO left side at all (owner,
 *  wave 7 sweep: the knowledge-context budget slider that used to live
 *  there died with the injection; a "— · —" summary over an empty
 *  popover is pure noise) — the dictation strip's middle simply widens.
 *
 * Spending arrives already priced by the server through Pi's catalog and
 * calculator. Missing cost stays "—", never fake zero. Context is a separate
 * completed-conversation measurement, never a money-log/summarizer fold or
 * transcript estimate. Its denominator follows the selected model, from the
 * catalog or the session's CLI report; model changes preserve the numerator.
 * Successful compaction clears the numerator and any old CLI report.
 */
export function StatsBar({
	turns,
	contextTokens = null,
	cliContextWindow = null,
	pricing,
	dictationSlot,
	chatId,
	leadingSlot,
	onModelChange,
	toolsAnchor,
	attachmentEditor,
	dictationActive = false,
	dictationError = false,
}: {
	turns: TurnUsage[];
	contextTokens?: number | null;
	cliContextWindow?: ReturnType<typeof cliContextWindowOf>;
	pricing?: SessionPricing;
	/** The bound session (per-session models, owner 2026-09-28): present
	 *  on the in-session bar — the model control binds THE SESSION'S own
	 *  record; absent on the draft surfaces, where it binds the strong
	 *  slot (the new-session default). */
	chatId?: string;
	/** The same effective identity the visible model control owns. */
	onModelChange?: (model: string | undefined) => void;
	/** The dictation strip (STT wave, 2026-09-17): the row's middle is dead
	 *  space between the session data and the model control — the mic
	 *  button lives there, and while recording the meter unfurls to fill
	 *  whatever width the row has (owner placement). */
	dictationSlot?: ReactNode;
	/** The row's LEFT edge (practice sessions, 2026-10-04): the home
	 *  composer's teach | practice switch rides here — before the session
	 *  data (which renders nothing pre-chat on that surface). */
	leadingSlot?: ReactNode;
	toolsAnchor?: HTMLElement | null;
	attachmentEditor?: RefObject<HTMLDivElement | null>;
	dictationActive?: boolean;
	dictationError?: boolean;
}) {
	const { compact, shared } = useAndroidLayout();
	const [attachmentStatus, setAttachmentStatus] = useState<{ uploading: boolean; error?: string }>();
	const [open, setOpen] = useState(false);
	const [selectedModel, setSelectedModel] = useState<string | undefined>();
	const modelChanged = useCallback((model: string | undefined) => {
		setSelectedModel(model);
		onModelChange?.(model);
	}, [onModelChange]);
	// Same dropdown discipline as the model control (owner, df4433f treatment,
	// stats round 1): close on any pointerdown outside the bar or on Escape.
	const barRef = useRef<HTMLDivElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const popupLayer = usePopoverDismiss(barRef, open && !!(chatId || turns.length), () => setOpen(false), { layerRootRef: panelRef });
	// The picker reports its effective selection. CLI windows are session-
	// scoped; unknown metadata always means usage-only, never a guessed maximum.
	const { catalog } = useModelCatalog();
	const limits = useMemo(() => (catalog ? catalogLimits(catalog) : undefined), [catalog]);
	const limit = contextLimitForModel(selectedModel, limits, cliContextWindow);
	const contextLabel = formatContextMeasurement(contextTokens, limit);
	const cacheHitRate = useMemo(() => sessionCacheHitRate({ turns }), [turns]);
	const { cost = 0, unpriced = turns.length, subscription = 0 } = pricing ?? {};
	// Honest cost: show dollars only when at least one turn priced;
	// otherwise "—" (never a fake $0.0000).
	const pricedCount = turns.length - unpriced - subscription;
	const providers = pricing?.subscriptionProviders ?? subscriptionLabels(turns.map((turn) => turn.model));
	const cliBilled = turns.some((turn) => turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`));
	const costLabel = planCostLabel(pricedCount > 0 ? cost : null, cliBilled ? [...providers, "CLI"] : providers);

	const summary = (chatId || turns.length > 0) && (
			<div ref={barRef} className="relative">
				{/* No tooltip — the numbers describe themselves and the popover
			    speaks on click (owner, subtlety round 2026-09-25). */}
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				aria-expanded={open}
				data-testid="stats-summary"
				className="flex items-center gap-1.5 tabular-nums transition-colors hover:text-foreground"
			>
				<span data-testid="stats-context">
					{contextLabel}
				</span>
				<span aria-hidden>·</span>
				<span data-testid="stats-cost">{costLabel}</span>
			</button>
				{open && (
					<div
						ref={panelRef}
						data-testid="stats-detail"
						style={{ zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order }}
						className="lh-android-inline-panel absolute bottom-full left-1/2 mb-1.5 w-72 -translate-x-1/2 rounded-xl border bg-card p-3 text-xs shadow-xl"
					>
						<div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Session stats
						</div>
						<div className="flex flex-col gap-1 text-muted-foreground">
							<div className="flex justify-between gap-2">
								<span>Context (last call)</span>
								<span className="tabular-nums text-card-foreground">
									{contextLabel}
								</span>
							</div>
							{selectedModel?.startsWith(`${CLAUDE_CODE_PROVIDER}:`) && (
								<p>Window reported by Claude Code; may be lower for auto-compaction.</p>
							)}
							<div className="flex justify-between gap-2">
								<span>{subscription ? "Usage" : "Total cost"}</span>
								<span className="tabular-nums text-card-foreground">{costLabel}</span>
							</div>
							{cacheHitRate !== null && (
								<div data-testid="stats-cache-hit-rate" className="flex justify-between gap-2">
									<span>Cache hit rate</span>
									<span className="tabular-nums text-card-foreground">{(cacheHitRate * 100).toFixed(1)}%</span>
								</div>
							)}
							{providers.includes("ChatGPT") && <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer" className="underline underline-offset-2">Manage ChatGPT usage</a>}
							{unpriced > 0 && (
								<div className="flex justify-between gap-2">
									<span>Unpriced turns</span>
									<span className="tabular-nums text-card-foreground">{unpriced}</span>
								</div>
							)}
						</div>
						{turns.length > 0 && (
							<>
								<div className="mb-1 mt-2.5 border-t pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
									Turns
								</div>
								<ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
									{turns.map((turn, i) => {
										const c = pricing?.turnCosts[turn.id] ?? null;
										return (
											<li key={`${turn.messageId}-${i}`} className="flex items-center justify-between gap-2">
												<span className="truncate text-muted-foreground">
													#{i + 1} · {prettyModel(turn.model, true)}
												</span>
												<span className="flex shrink-0 items-center gap-2 tabular-nums text-card-foreground">
													<span className="text-muted-foreground">{turn.steps.length} steps</span>
													<span>{turn.model.startsWith(`${CLAUDE_CODE_PROVIDER}:`) ? "CLI" : subscriptionLabel(turn.model) ?? (c === null ? "—" : formatUsd(c))}</span>
												</span>
											</li>
										);
									})}
								</ul>
							</>
						)}
					</div>
				)}
			</div>
	);
	const visibleDictation = compact && (dictationActive || dictationError);
	const dictation = dictationSlot && <div className="flex min-w-0 flex-1 items-center justify-center">{dictationSlot}</div>;

	return (
		<div data-testid="stats-bar" className="lh-composer-stats pointer-events-auto relative flex items-center justify-between gap-3 px-3 pt-2 text-xs text-muted-foreground">
			{leadingSlot}
			{compact && attachmentStatus?.uploading && <p role="status">Attaching files…</p>}
			{compact && attachmentStatus?.error && <p role="alert" className="break-words text-error">{attachmentStatus.error}</p>}
			{visibleDictation && dictation}
			{shared && !chatId ? <div hidden><ModelControl onModelChange={modelChanged} /></div> : <AndroidActions label="Composer tools" anchor={toolsAnchor} composer closeWhile={dictationActive}>
				{sheet => <>
					{!shared && sheet && toolsAnchor && attachmentEditor && <AttachFilesButton editorRef={attachmentEditor}
						androidSheet={{ onPick: sheet.close, onStatus: setAttachmentStatus }} />}
					{!sheet && summary}
					{!visibleDictation && dictation}
					<ModelControl chatId={chatId} onModelChange={modelChanged} shortcut={sheet} />
					{sheet && summary}
				</>}
			</AndroidActions>}
		</div>
	);
}
