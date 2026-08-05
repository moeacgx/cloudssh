import { createContext, useContext, type ReactNode } from "react";

const ProjectHostContext = createContext<number | undefined>(undefined);

export function ProjectHostProvider({
  projectHostId,
  children,
}: {
  projectHostId?: number;
  children: ReactNode;
}) {
  return (
    <ProjectHostContext.Provider value={projectHostId}>
      {children}
    </ProjectHostContext.Provider>
  );
}

// Provider 与读取 Hook 必须共享同一上下文实例，避免项目主机标识串线。
// eslint-disable-next-line react-refresh/only-export-components
export function useProjectHostId(): number | undefined {
  return useContext(ProjectHostContext);
}
