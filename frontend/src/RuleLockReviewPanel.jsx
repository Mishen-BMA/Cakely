import { CheckCircle2, Circle, XCircle } from 'lucide-react'

const components = [
  ['c1_data_collection', 'C1 · Data collection'],
  ['c2_rule_engine', 'C2 · Rule engine'],
  ['c3_anomaly', 'C3 · Anomaly detection'],
  ['c4_enforcement', 'C4 · Enforcement'],
]

function Icon({ passed }) {
  if (passed === false || passed === 'fail' || passed === 'high_risk' || passed === 'reject') return <XCircle size={17} aria-label="Failed" />
  if (passed === true || passed === 'pass' || passed === 'normal' || passed === 'accept' || passed === 'void_discount') return <CheckCircle2 size={17} aria-label="Passed" />
  return <Circle size={17} aria-label="Status unavailable" />
}

export default function RuleLockReviewPanel({ review, admin = false, open = false }) {
  if (!review) return <details className="rulelock-review" open={open}><summary>RuleLock validation</summary><p>Not validated - RuleLock off</p></details>
  const pipeline = review.pipeline || {}
  const anomaly = pipeline.c3_anomaly || {}
  const checks = pipeline.c2_rule_engine?.checks || []
  const account = pipeline.c1_data_collection?.account
  return <details className="rulelock-review" open={open}><summary>RuleLock validation</summary>
    {review.error && <p>{review.error}</p>}
    <div className="rulelock-components">{components.map(([key, title]) => {
      const component = pipeline[key]
      const state = key === 'c2_rule_engine' ? component?.status : key === 'c3_anomaly' ? component?.status : key === 'c4_enforcement' ? component?.decision : component?.status
      return <section key={key}><h4><Icon passed={state} />{title}</h4><small>Status: {state || 'Unavailable'}</small>
        {key === 'c1_data_collection' && component?.session_features && <small>Session features: {Object.entries(component.session_features).map(([label, value]) => `${label}: ${value}`).join(' · ')}</small>}
        {key === 'c2_rule_engine' && component?.violations?.map((violation, index) => <small key={index}>Violation: {violation.code} · {violation.reason}</small>)}
        {key === 'c3_anomaly' && <small>Score: {anomaly.score ?? '-'} · Hold: {anomaly.hold_threshold ?? '-'} · Reject: {anomaly.reject_threshold ?? '-'}</small>}
        {key === 'c4_enforcement' && component && <small>Decision: {component.decision || review.decision} · Action: {component.action || '-'} · Account: {component.account_action?.type || (typeof component.account_action === 'object' ? JSON.stringify(component.account_action) : component.account_action) || '-'}</small>}
      </section>
    })}</div>
    {checks.length > 0 && <section className="rulelock-checks"><h4>Rule checks</h4>{checks.map((check, index) => <small key={`${check.code}-${index}`}><Icon passed={check.passed} /> <strong>{check.label || check.code}</strong>: {check.detail || (check.passed ? 'Passed' : 'Failed')}</small>)}</section>}
    <p className="rulelock-cause"><strong>Cause:</strong> {review.reason || review.customer_message || 'No cause provided.'}</p>
    {admin && account && <section className="rulelock-account"><h4>Account context</h4><small>User {account.username || account.user_id} · Age {account.account_age_days ?? '-'} days · Completed {account.completed_orders ?? '-'} · COD {account.cod_orders ?? '-'} · Bad COD {account.cod_bad_orders ?? '-'}</small></section>}
  </details>
}
