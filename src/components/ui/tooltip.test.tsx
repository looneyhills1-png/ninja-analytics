import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { HelpTip, Tooltip } from "@/components/ui/tooltip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// jsdom has no PointerEvent, so give a plain event the pointerType React reads.
const touch = (type: string) =>
  Object.assign(new MouseEvent(type, { bubbles: true }), {
    pointerType: "touch",
  });

const tip = () => screen.getByRole("tooltip", { hidden: true });
const shown = () => tip().getAttribute("data-open") === "true";

describe("Tooltip", () => {
  it("is hidden until hovered, then explains the control", () => {
    render(
      <Button help="Does a harmless thing." effect="read">
        Go
      </Button>,
    );
    expect(shown()).toBe(false);
    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "Go" }).parentElement!,
    );
    expect(shown()).toBe(true);
    expect(tip().textContent).toContain("Does a harmless thing.");
    expect(tip().textContent).toContain("Read-only: changes nothing.");
  });

  it("opens on keyboard focus and closes on Escape", () => {
    render(<Button help="Explains itself.">Go</Button>);
    fireEvent.focus(screen.getByRole("button", { name: "Go" }));
    expect(shown()).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(shown()).toBe(false);
  });

  it("is wired to the control with aria-describedby", () => {
    render(<Button help="Explains itself.">Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("aria-describedby")).toBe(tip().id);
  });

  it("shows the explanation on a touch press-and-hold without firing the action", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(
      <Button help="Hold to read." onClick={onClick}>
        Go
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    const wrapper = button.parentElement!;
    fireEvent(wrapper, touch("pointerdown"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(shown()).toBe(true);
    fireEvent(wrapper, touch("pointerup"));
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a normal touch tap still performs the action", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(
      <Button help="Tap works." onClick={onClick}>
        Go
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Go" });
    const wrapper = button.parentElement!;
    fireEvent(wrapper, touch("pointerdown"));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent(wrapper, touch("pointerup"));
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("explains why a disabled control is unavailable and stays keyboard reachable", () => {
    render(
      <Button
        help="Does a thing."
        disabled
        disabledReason="Ollama is not running."
      >
        Go
      </Button>,
    );
    const wrapper = screen.getByRole("button", { name: "Go" }).parentElement!;
    expect(wrapper.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(wrapper);
    expect(shown()).toBe(true);
    expect(tip().textContent).toContain("Unavailable: Ollama is not running.");
  });

  it("marks actions that can change a website", () => {
    render(
      <HelpButton help="Publishes." effect="website">
        Run
      </HelpButton>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Run" }));
    expect(tip().textContent).toContain("Can change your live website");
  });

  it("keeps a legacy title working as the help text", () => {
    render(<Button title="Old title text">Go</Button>);
    fireEvent.focus(screen.getByRole("button", { name: "Go" }));
    expect(tip().textContent).toContain("Old title text");
  });

  it("HelpTip gives charts and badges a focusable explanation", () => {
    render(
      <p>
        Trend <HelpTip>Compares the last 28 days with the 28 before.</HelpTip>
      </p>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "More information" }));
    expect(tip().textContent).toContain("28 days");
  });

  it("works around an arbitrary element too", () => {
    render(
      <Tooltip content="A status badge.">
        <span>OK</span>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText("OK").parentElement!);
    expect(shown()).toBe(true);
  });
});
