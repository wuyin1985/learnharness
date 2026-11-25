import { DumbbellIcon } from "lucide-react";

export function SessionModeSwitch({ mode, onChange }: {
	mode: "teach" | "practice";
	onChange: (mode: "teach" | "practice") => void;
}) {
	return (
		<div className="lh-session-mode-switch flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="home-mode-switch">
			{(["teach", "practice"] as const).map(value => (
				<button key={value} type="button" data-testid={`home-mode-${value}`}
					aria-pressed={mode === value} onClick={() => onChange(value)}
					className={`flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] uppercase tracking-wider transition-colors ${mode === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
					{value === "practice" && <DumbbellIcon aria-hidden className="size-3" />}
					{value === "teach" ? "Teach" : "Practice"}
				</button>
			))}
		</div>
	);
}
