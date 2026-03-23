import { useEffect } from 'react'
import './AppShell.css'
import { signOutCurrentUser } from '../engineweb/auth/cognito.ts'
import { usePublicWorkspaceController } from '../engineweb/usePublicWorkspaceController.ts'
import { UserAuthGate } from '../features/auth/UserAuthGate.tsx'
import { AulasView } from '../features/aulas/AulasView.tsx'
import { LearningView } from '../features/aprendizado/LearningView.tsx'
import { WorksView } from '../features/trabalhos/WorksView.tsx'
import { CommunityView } from '../features/community/CommunityHub.tsx'
import { getAnonymousCommunityViewer } from '../features/community/storage.ts'
import { BrandMark, NavigationTabs } from './ShellPrimitives.tsx'

const LAUNCHER_PROFILE = (import.meta.env.VITE_LAUNCHER_PROFILE ?? '').trim()

export function PublicAppShell() {
  return (
    <UserAuthGate>
      {({ userLabel, userId, isGuest }) => <PublicApp userLabel={userLabel} userId={userId} isGuest={isGuest} />}
    </UserAuthGate>
  )
}

function PublicApp(props: { userLabel: string; userId: string | null; isGuest: boolean }) {
  const controller = usePublicWorkspaceController()
  const labMode = LAUNCHER_PROFILE === 'lab_preview'
  const anonymousViewer = getAnonymousCommunityViewer()

  useEffect(() => {
    document.title = labMode ? 'FiapFlow LAB' : 'FiapFlow'
  }, [labMode])

  return (
    <main className="simple-app">
      <section className="hero-card">
        <div className="hero-topbar">
          <div className="brand-block">
            <div className="brand-line">
              <BrandMark />
              <p className="eyebrow">FiapFlow</p>
            </div>
            <h1>Assistente de Estudos</h1>
          </div>
          {props.userLabel ? (
            <div className="action-row">
              {labMode ? <span className="admin-badge">LAB PREVIEW {window.location.port || ''}</span> : null}
              <span className="admin-badge">{props.userLabel}</span>
              <button type="button" className="secondary-button" onClick={() => void signOutCurrentUser().then(() => window.location.reload())}>
                Sair
              </button>
            </div>
          ) : null}
        </div>
      </section>

      <NavigationTabs activeTab={controller.activeTab} onChange={controller.setActiveTab} />
      <ContentByTab
        controller={controller}
        communityViewer={{
          userId: props.userId ?? anonymousViewer.userId,
          userLabel: props.userLabel || (props.isGuest ? 'Visitante' : anonymousViewer.userLabel),
          isGuest: props.isGuest,
          canParticipate: true,
          source: props.userId ? 'authenticated' : 'anonymous',
        }}
      />

      <section className="footer-card compact-footer">
        <p className="eyebrow">Atividade</p>
        <strong>{controller.activity}</strong>
      </section>
    </main>
  )
}

function ContentByTab(props: {
  controller: ReturnType<typeof usePublicWorkspaceController>
  communityViewer: {
    userId: string | null
    userLabel: string
    isGuest: boolean
    canParticipate: boolean
    source?: 'authenticated' | 'anonymous'
  }
}) {
  return props.controller.activeTab === 'aulas'
    ? <AulasView controller={props.controller} />
    : props.controller.activeTab === 'trabalhos'
      ? <WorksView controller={props.controller} />
      : props.controller.activeTab === 'aprendizado'
        ? <LearningView controller={props.controller} />
        : <CommunityView viewer={props.communityViewer} />
}
