export interface RigaCalcolo {
  quantita: number;
  prezzoUnitarioApplicato: number;
  scontoPercentuale: number;
  aliquotaIva: number;
}

export function calcolaTotali(righe: RigaCalcolo[]) {
  let totaleImponibile = 0;
  let totaleImposte = 0;

  for (const r of righe) {
    const imponibile =
      r.quantita * r.prezzoUnitarioApplicato * (1 - (r.scontoPercentuale || 0) / 100);
    totaleImponibile += imponibile;
    totaleImposte += imponibile * ((r.aliquotaIva || 22) / 100);
  }

  return {
    totaleImponibile: Math.round(totaleImponibile * 100) / 100,
    totaleImposte: Math.round(totaleImposte * 100) / 100,
    totaleLordo: Math.round((totaleImponibile + totaleImposte) * 100) / 100,
  };
}
