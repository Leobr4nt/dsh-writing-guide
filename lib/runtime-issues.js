/** Bounded, privacy-safe diagnostic groups. total is monotonic even after repeat/overflow. */
export function createIssueBuffer(classify,limit=64){
  const groups=new Map();let total=0,omitted=0;
  return {
    record(error){
      const issue=classify(error),key=JSON.stringify(issue);total++;
      const old=groups.get(key);
      if(old){old.count++;return;}
      if(groups.size>=limit){const first=groups.keys().next().value;omitted+=groups.get(first).count;groups.delete(first);}
      groups.set(key,{...issue,count:1});
    },
    get total(){return total;},
    snapshot(){return {errors:[...groups.values()].map(issue=>({...issue})),errorCount:total,omittedErrorCount:omitted};},
  };
}

export function mergeIssueSnapshots(...snapshots){
  const groups=new Map();let errorCount=0,omittedErrorCount=0;
  for(const snapshot of snapshots){
    errorCount+=snapshot.errorCount;omittedErrorCount+=snapshot.omittedErrorCount;
    for(const {count,...issue} of snapshot.errors){
      const key=JSON.stringify(issue),old=groups.get(key);
      if(old)old.count+=count;else groups.set(key,{...issue,count});
    }
  }
  return {errors:[...groups.values()],errorCount,omittedErrorCount};
}
