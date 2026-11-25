"use client";

import { createContext, useContext, useLayoutEffect, useState } from "react";

const layoutDefault = { compact: false, drawer: false };
const AndroidLayoutContext = createContext({ android: false, ...layoutDefault });

export function useAndroidLayout() {
	return useContext(AndroidLayoutContext);
}

export function AndroidLayoutProvider({ android, children }: { android: boolean; children: React.ReactNode }) {
	const [layout, setLayout] = useState(layoutDefault);
	useLayoutEffect(() => {
		if (!android) return;
		const root = document.documentElement;
		let width = 0;
		let restingHeight = 0;
		let frame = 0;
		const measure = () => {
			const height = window.innerHeight;
			if (width !== window.innerWidth) {
				width = window.innerWidth;
				restingHeight = height;
			}
			// adjustResize changes the WebView's layout height as well as its
			// visual viewport. Keep the layout class stable during typing.
			const editing = document.activeElement?.matches("input, textarea, [contenteditable]:not([contenteditable=false])");
			const keyboard = !!editing && restingHeight - (window.visualViewport?.height ?? height) > 120;
			if (!keyboard) restingHeight = height;
			const short = restingHeight < 480;
			const compact = width < 600 || short;
			const drawer = width < 840 || short;
			root.classList.toggle("lh-android-compact", compact);
			root.classList.toggle("lh-android-drawer", drawer);
			root.classList.toggle("lh-android-keyboard", keyboard);
			setLayout(current => current.compact === compact && current.drawer === drawer ? current : { compact, drawer });
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};
		measure();
		window.addEventListener("resize", schedule);
		window.visualViewport?.addEventListener("resize", schedule);
		document.addEventListener("focusin", schedule);
		return () => {
			window.removeEventListener("resize", schedule);
			window.visualViewport?.removeEventListener("resize", schedule);
			document.removeEventListener("focusin", schedule);
			cancelAnimationFrame(frame);
			root.classList.remove("lh-android-compact", "lh-android-drawer", "lh-android-keyboard");
		};
	}, [android]);
	return <AndroidLayoutContext.Provider value={{ android, ...layout }}>{children}</AndroidLayoutContext.Provider>;
}
