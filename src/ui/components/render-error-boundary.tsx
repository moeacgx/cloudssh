import { Component, type ReactNode } from "react";

interface RenderErrorBoundaryProps {
  children: ReactNode;
  fallback: (reset: () => void) => ReactNode;
}

interface RenderErrorBoundaryState {
  failed: boolean;
}

export class RenderErrorBoundary extends Component<
  RenderErrorBoundaryProps,
  RenderErrorBoundaryState
> {
  state: RenderErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): RenderErrorBoundaryState {
    return { failed: true };
  }

  private reset = () => this.setState({ failed: false });

  render() {
    if (this.state.failed) return this.props.fallback(this.reset);
    return this.props.children;
  }
}
