declare module "react-window" {
  import * as React from "react";

  export interface ListChildComponentProps {
    index: number;
    style: React.CSSProperties;
  }

  export interface FixedSizeListProps {
    height: number;
    width: number | string;
    itemCount: number;
    itemSize: number;
    className?: string;
    children: (props: ListChildComponentProps) => React.ReactElement | null;
  }

  export class FixedSizeList extends React.Component<FixedSizeListProps> {
    scrollToItem(index: number, align?: "auto" | "smart" | "start" | "center" | "end"): void;
  }
}
