"use client";

import { EllipsisIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAndroidLayout } from "./android-layout";
import { INTERACTION_LAYER_Z_BASE } from "./host-dialog";
import { InteractionLayerOwner, useInteractionLayer, useInteractionLayers } from "./interaction-layers";
import { useBackdropDismiss } from "./backdrop-dismiss";

type Actions = {
	label: string;
	anchor?: HTMLElement | null;
	composer?: boolean;
	closeWhile?: boolean;
	children: (sheet?: { close: () => void; open: () => void; trigger: RefObject<HTMLButtonElement | null> }) => ReactNode;
};

/** Keep the existing control components mounted while the sheet is folded.
 * They own the model selection, pending file picker, and graph filters. */
export function AndroidActions(props: Actions) {
	const { compact } = useAndroidLayout();
	return compact ? <CompactActions {...props} /> : props.children();
}

function CompactActions({ label, anchor, composer, closeWhile, children }: Actions) {
	const [open, setOpen] = useState(false);
	const trigger = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLDivElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const id = useId();
	const controller = useInteractionLayers();
	const close = () => setOpen(false);
	const restoreTrigger = useRef(false);
	const layer = useInteractionLayer({
		kind: "popup", enabled: open, rootRef: panel, anchorRef: trigger,
		onClose: () => {
			restoreTrigger.current = true;
			close();
			return "closed";
		},
	});
	const dismiss = () => {
		if (controller.popTo(layer.id) === "closed") controller.requestClose(layer.id, "outside");
	};
	const backdrop = useBackdropDismiss(dismiss);
	const focused = useRef(false);
	useEffect(() => {
		if (!open) {
			focused.current = false;
			if (restoreTrigger.current && controller.isElementEligible(trigger.current)) trigger.current?.focus({ preventScroll: true });
			restoreTrigger.current = false;
		}
		if (open && layer.isTop && !focused.current) {
			focused.current = true;
			heading.current?.focus({ preventScroll: true });
		}
	}, [open, layer.isTop, controller]);
	useEffect(() => { if (closeWhile) setOpen(false); }, [closeWhile]);
	const button = (
		<button ref={trigger} type="button" aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={open}
			aria-controls={id} className="lh-android-action-trigger flex size-12 shrink-0 items-center justify-center rounded-xl border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
			onClick={() => setOpen(true)}>
			{composer && anchor ? <PlusIcon className="size-5" aria-hidden /> : <EllipsisIcon className="size-5" aria-hidden />}
		</button>
	);
	return <>
		{anchor ? createPortal(button, anchor) : button}
		{createPortal(
			<InteractionLayerOwner.Provider value={layer.id}>
				<div hidden={!open} className="lh-android-sheet fixed inset-0" style={{ zIndex: INTERACTION_LAYER_Z_BASE + layer.order }}>
					<div className="absolute inset-0 bg-black/55" aria-hidden="true" {...backdrop} />
					<div ref={panel} id={id} role="dialog" aria-labelledby={`${id}-title`}
						className="lh-android-sheet-panel absolute inset-x-0 bottom-0 mx-auto flex max-h-[calc(100dvh-12px)] w-full max-w-lg flex-col overflow-y-auto overscroll-contain rounded-t-2xl border bg-card shadow-xl">
						<div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-card px-4 py-1">
							<h2 ref={heading} id={`${id}-title`} tabIndex={-1} className="font-title text-xl outline-none">{label}</h2>
							<button type="button" aria-label={`Close ${label}`} onClick={dismiss}
								className="flex size-12 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent">
								<XIcon className="size-5" aria-hidden />
							</button>
						</div>
						<div className="lh-android-sheet-controls flex flex-col gap-2 p-4">
							{children({ close, open: () => setOpen(true), trigger })}
						</div>
					</div>
				</div>
			</InteractionLayerOwner.Provider>, document.body)}
	</>;
}
