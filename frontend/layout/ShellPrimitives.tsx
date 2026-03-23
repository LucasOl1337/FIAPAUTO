type NavigationTab = 'aulas' | 'trabalhos' | 'aprendizado' | 'comunidade'

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <img src="/brand-icon.jpg" alt="" />
    </span>
  )
}

export function NavigationTabs(props: {
  activeTab: NavigationTab
  onChange: (tab: NavigationTab) => void
}) {
  return (
    <section className="tab-row">
      <button type="button" className={props.activeTab === 'aulas' ? 'tab-button active' : 'tab-button'} onClick={() => props.onChange('aulas')}>Aulas</button>
      <button type="button" className={props.activeTab === 'trabalhos' ? 'tab-button active' : 'tab-button'} onClick={() => props.onChange('trabalhos')}>Trabalhos</button>
      <button type="button" className={props.activeTab === 'aprendizado' ? 'tab-button active' : 'tab-button'} onClick={() => props.onChange('aprendizado')}>Aprendizado</button>
      <button type="button" className={props.activeTab === 'comunidade' ? 'tab-button active' : 'tab-button'} onClick={() => props.onChange('comunidade')}>Comunidade</button>
    </section>
  )
}
