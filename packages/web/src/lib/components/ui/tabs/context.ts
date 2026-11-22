import { getContext, setContext } from "svelte";

export type Orientation = "horizontal" | "vertical";
export type TabsContext = {
  id: string;
  readonly value: string;
  readonly orientation: Orientation;
  select: (value: string) => void;
};
const key = Symbol("tabs");
export const setTabsContext = (context: TabsContext) => setContext(key, context);
export const getTabsContext = () => getContext<TabsContext>(key);
