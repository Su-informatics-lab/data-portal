import React, { useEffect, useState, useRef } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { askGuppyForRawData } from '@gen3/guppy/dist/components/Utils/queries';
import { guppyUrl } from '../../localconf';

const ARDaCSurvivalCurve = ({ fetchAndUpdateRawData, casecount, guppyConfig }) => {
  const [survivalData, setSurvivalData] = useState({});
  const [outcomeType, setOutcomeType] = useState('death');
  const [groupingField, setGroupingField] = useState('cohort');
  const [patientCounts, setPatientCounts] = useState({});
  const [rawData, setRawData] = useState(null);
  const [dataQuality, setDataQuality] = useState({});

  const fetchingRef = useRef(false);

  const DATA_LIMIT = 5000;
  const COLORS = ['#2196F3', '#F44336', '#4CAF50', '#FF9800', '#9C27B0'];

  // outcome type
  const outcomeTypes = [
    { value: 'death', label: 'Death (Overall Survival)' },
    { value: 'aki', label: 'AKI (Time to AKI)' }
  ];

  // group type
  const groupingFields = [
    { value: 'none', label: 'NO GROUPING' },
    { value: 'cohort', label: 'COHORT' },
    { value: 'gender', label: 'GENDER' }
  ];

  useEffect(() => {
    const fetchData = async () => {
      if (fetchingRef.current || !casecount || casecount <= 0) return;

      try {
        fetchingRef.current = true;

        console.log('Fetching data with params:', {
          casecount,
          groupingField,
          fetchParams: {
            offset: 0,
            size: Math.min(DATA_LIMIT, casecount),
            sort: []
          }
        });

        // get case data
        const caseRes = await fetchAndUpdateRawData({
          offset: 0,
          size: Math.min(DATA_LIMIT, casecount),
          sort: []
        });

        console.log('Raw response:', caseRes);

        if (!caseRes?.data) {
          throw new Error('No case data available');
        }

        console.log('Case data structure:', {
          hasData: !!caseRes?.data,
          dataLength: caseRes?.data?.length || 0,
          sampleFields: caseRes?.data?.[0] ? Object.keys(caseRes.data[0]) : 'No fields',
        });

        console.log('First 2 case records:', caseRes?.data?.slice(0, 2));

        // processedData: fnmax is not working in ETL
        const processedData = {
          ...caseRes,
          data: caseRes.data
            .filter(record => record?.pat_id)
            .map(record => ({
              ...record,
              // use max value from visit_day_set, then fallback to other fields
              days_to_follow_up: (() => {
                // first choice: use max value from visit_day_set
                if (record.visit_day_set && Array.isArray(record.visit_day_set) && record.visit_day_set.length > 0) {
                  const validDays = record.visit_day_set
                    .map(day => parseInt(day))
                    .filter(day => !isNaN(day) && day >= 0);
                  if (validDays.length > 0) {
                    return Math.max(...validDays);
                  }
                }
                
                // second choice: use max_days_to_follow_up_test/visit_day/0
                return record.max_days_to_follow_up_test || record.visit_day || 0;
              })()
            }))
        };

        console.log(`Processed ${processedData.data.length} case records with follow-up data`);

        setRawData(processedData);
        console.log('Processed case data with follow-up:', processedData);

      } catch (error) {
        console.error('Error fetching ARDaC case data:', error);
      } finally {
        fetchingRef.current = false;
      }
    };

    fetchData();
  }, [casecount, fetchAndUpdateRawData, guppyConfig, groupingField]);

  // data quality check
  const checkDataQuality = (data) => {
    const quality = {
      totalPatients: data.length,
      deathEvents: 0,
      akiEvents: 0,
      missingDeathTime: 0,
      missingAkiTime: 0,
      negativeDays: 0,
      warnings: []
    };

    data.forEach(patient => {
      // check death data
      if (patient.vital_status === 'dead') {
        quality.deathEvents++;
        if (!patient.days_to_death || patient.days_to_death === '' || patient.days_to_death < 0) {
          quality.missingDeathTime++;
        }
      }

      // check aki data
      if (patient.aki_status === 'Yes') {
        quality.akiEvents++;
        if (!patient.days_to_aki || patient.days_to_aki === '' || patient.days_to_aki < 0) {
          quality.missingAkiTime++;
        }
      }

      // check negative days
      if ((patient.days_to_death && parseInt(patient.days_to_death) < 0) ||
        (patient.days_to_aki && parseInt(patient.days_to_aki) < 0)) {
        quality.negativeDays++;
      }
    });

    // generate warnings
    if (quality.missingDeathTime > 0) {
      quality.warnings.push(`${quality.missingDeathTime} patients with death status 'dead' but missing/blank death time or negative death time`);
    }
    if (quality.missingAkiTime > 0) {
      quality.warnings.push(`${quality.missingAkiTime} patients with AKI status 'Yes' but missing/blank AKI time or negative AKI time`);
    }
    if (quality.negativeDays > 0) {
      quality.warnings.push(`${quality.negativeDays} patients with negative time values`);
    }

    return quality;
  };

  // prepare survival data
  const prepareSurvivalData = (rawData, outcome, groupBy) => {
    const survivalPatients = [];
    const debugInfo = {
      totalPatients: rawData.length,
      excludedPatients: 0,
      negativeTimes: 0,
      missingTimes: 0,
      timeRange: { min: Infinity, max: -Infinity }
    };

    // check follow-up times for censored patients
    console.log('Follow-up times for censored patients:',
      rawData.filter(p => {
        if (outcome === 'death') {
          return p.vital_status !== 'dead';
        } else if (outcome === 'aki') {
          return p.aki_status !== 'Yes';
        }
        return false;
      }).map(p => ({
        pat_id: p.pat_id,
        days_to_follow_up: p.days_to_follow_up,
        max_days_to_follow_up_test: p.max_days_to_follow_up_test,
        visit_day: p.visit_day,
        final_time: p.max_days_to_follow_up_test || p.visit_day || p.days_to_follow_up || 0
      }))
    );

    // check censored times
    const censoredTimes = {};
    rawData.forEach(patient => {
      let isCensored = false;
      let time = null;

      if (outcome === 'death') {
        if (patient.vital_status !== 'dead') {
          isCensored = true;
          time = patient.max_days_to_follow_up_test || patient.visit_day || patient.days_to_follow_up || 0;
        }
      } else if (outcome === 'aki') {
        if (patient.vital_status !== 'dead' && patient.aki_status !== 'Yes') {
          isCensored = true;
          time = patient.max_days_to_follow_up_test || patient.visit_day || patient.days_to_follow_up || 0;
        }
      }

      if (isCensored) {
        censoredTimes[time] = (censoredTimes[time] || 0) + 1;
      }
    });

    console.log('Censored patients time distribution:', censoredTimes);
    console.log('Unique censored times:', Object.keys(censoredTimes).length);

    rawData.forEach(patient => {
      let time = null;
      let event = 0;
      let groupValue = groupBy === 'none' ? 'All' : (patient[groupBy] || 'Unknown');

      if (outcome === 'death') {
        if (patient.vital_status === 'dead') {
          if (patient.days_to_death && patient.days_to_death >= 0) {
            const deathDays = parseInt(patient.days_to_death);
            time = deathDays;
            event = 1;
          } else {
            debugInfo.negativeTimes++;
            time = patient.days_to_follow_up;
            event = 1;
          }
        } else {
          time = patient.days_to_follow_up;
          event = 0;
        }
      } else if (outcome === 'aki') {
        if (patient.vital_status === 'dead' && patient.aki_status === 'Yes') {
          // two events, compare time
          const deathTime = patient.days_to_death && patient.days_to_death >= 0
            ? parseInt(patient.days_to_death)
            : parseInt(patient.days_to_follow_up);

          const akiTime = patient.days_to_aki && patient.days_to_aki >= 0
            ? parseInt(patient.days_to_aki)
            : parseInt(patient.days_to_follow_up);

          if (akiTime !== null && akiTime <= deathTime) {
            // AKI before or at death
            time = akiTime;
            event = 1;
          } else {
            // death before aki or aki time is invalid
            time = deathTime;
            event = 0; // censored by death
          }
        } else if (patient.vital_status === 'dead') {
          // only death, censored
          time = patient.days_to_death && patient.days_to_death >= 0
            ? parseInt(patient.days_to_death)
            : patient.days_to_follow_up;
          event = 0;
        } else if (patient.aki_status === 'Yes') {
          // only aki
          if (patient.days_to_aki && patient.days_to_aki >= 0) {
            time = parseInt(patient.days_to_aki);
            event = 1;
          } else {
            debugInfo.negativeTimes++;
            time = patient.days_to_follow_up;
            event = 1;
          }
        } else {
          // no event, censored
          time = patient.days_to_follow_up;
          event = 0;
        }
      }

      if (time !== null && time >= 0) {
        survivalPatients.push({
          patientId: patient.pat_id,
          time: time,
          event: event,
          group: groupValue
        });

        // update time range
        debugInfo.timeRange.min = Math.min(debugInfo.timeRange.min, time);
        debugInfo.timeRange.max = Math.max(debugInfo.timeRange.max, time);
      } else {
        debugInfo.excludedPatients++;
      }
    });

    console.log('Survival data preparation debug info:', debugInfo);
    console.log('Patients:', survivalPatients);

    return survivalPatients;
  };

  // Kaplan-Meier calculation
  const calculateSurvivalData = (patients) => {
    if (!patients.length) return [];

    console.log('Kaplan-Meier calculation for group:', {
      totalPatients: patients.length,
      events: patients.filter(p => p.event === 1).length,
      censored: patients.filter(p => p.event === 0).length,
      timeRange: {
        min: Math.min(...patients.map(p => p.time)),
        max: Math.max(...patients.map(p => p.time))
      }
    });

    // sort by time
    patients.sort((a, b) => a.time - b.time);



    // check final survival
    const checkFinalSurvival = (sortedPatients) => {
      const lastEventIndex = sortedPatients.map(p => p.event).lastIndexOf(1);
      const lastCensoredIndex = sortedPatients.map(p => p.event).lastIndexOf(0);
      
      // get last event and censored patient
      const lastEventPatient = lastEventIndex >= 0 ? sortedPatients[lastEventIndex] : null;
      const lastCensoredPatient = lastCensoredIndex >= 0 ? sortedPatients[lastCensoredIndex] : null;
      
      console.log('Final survival check:', {
        lastEventIndex,
        lastCensoredIndex,
        lastEventTime: lastEventPatient?.time || 'None',
        lastCensoredTime: lastCensoredPatient?.time || 'None',
        lastEventPatientId: lastEventPatient?.patientId || 'None',
        lastCensoredPatientId: lastCensoredPatient?.patientId || 'None',
        totalEvents: sortedPatients.filter(p => p.event === 1).length,
        totalCensored: sortedPatients.filter(p => p.event === 0).length
      });
  
      // show last few events and censored patients
      const lastFewEvents = sortedPatients
        .filter(p => p.event === 1)
        .slice(-3)
        .map(p => ({ patientId: p.patientId, time: p.time, event: p.event }));
      
      const lastFewCensored = sortedPatients
        .filter(p => p.event === 0)
        .slice(-3)
        .map(p => ({ patientId: p.patientId, time: p.time, event: p.event }));
  
      console.log('Last few events:', lastFewEvents);
      console.log('Last few censored:', lastFewCensored);
  
      if (lastEventIndex >= 0 && lastCensoredIndex >= 0) {
        const lastEventTime = sortedPatients[lastEventIndex].time;
        const lastCensoredTime = sortedPatients[lastCensoredIndex].time;
        
        if (lastEventTime > lastCensoredTime) {
          console.log(`✓ Last event (Patient ${lastEventPatient.patientId} at day ${lastEventTime}) occurred after all censoring - no survivors expected`);
          return { hasFinalSurvivors: false, reason: 'Last event after all censoring' };
        } else if (lastEventTime === lastCensoredTime) {
          console.log(`⚠ Last event (Patient ${lastEventPatient.patientId}) and censoring (Patient ${lastCensoredPatient.patientId}) occurred at same time (day ${lastEventTime})`);
          return { hasFinalSurvivors: true, reason: 'Same time as last censoring' };
        } else {
          console.log(`✓ Censoring (Patient ${lastCensoredPatient.patientId} at day ${lastCensoredTime}) occurred after last event (Patient ${lastEventPatient.patientId} at day ${lastEventTime}) - survivors expected`);
          return { hasFinalSurvivors: true, reason: 'Censoring after last event' };
        }
      } else if (lastEventIndex >= 0 && lastCensoredIndex < 0) {
        console.log(`✓ Only events, no censoring. Last event: Patient ${lastEventPatient.patientId} at day ${lastEventPatient.time} - no survivors expected`);
        return { hasFinalSurvivors: false, reason: 'No censoring occurred' };
      } else if (lastEventIndex < 0 && lastCensoredIndex >= 0) {
        console.log(`✓ Only censoring, no events. Last censored: Patient ${lastCensoredPatient.patientId} at day ${lastCensoredPatient.time} - all should survive`);
        return { hasFinalSurvivors: true, reason: 'Only censoring, no events' };
      } else {
        console.log('⚠ No events or censoring found');
        return { hasFinalSurvivors: true, reason: 'No data' };
      }
    };
  
    const finalSurvivalCheck = checkFinalSurvival(patients);

  ////
    

    const survivalPoints = [{ time: 0, survival: 1.0, atRisk: patients.length }];

    // group by time
    const timeGroups = {};
    patients.forEach(patient => {
      if (!timeGroups[patient.time]) {
        timeGroups[patient.time] = { events: 0, censored: 0 };
      }
      if (patient.event === 1) {
        timeGroups[patient.time].events++;
      } else {
        timeGroups[patient.time].censored++;
      }
    });

    let atRisk = patients.length;
    let survivalProb = 1.0;


    console.log('Time groups:', timeGroups);

    // calculate survival probability
    for (const time of Object.keys(timeGroups).sort((a, b) => a - b)) {
      const { events, censored } = timeGroups[time];

      if (atRisk <= 0) {
        // if risk set is empty, stop calculation
        break;
      }

      if (events > 0) {
        survivalProb *= (1 - events / atRisk);

        survivalPoints.push({
          time: parseInt(time),
          survival: survivalProb,
          atRisk: atRisk,
          event: events,
          censored: censored
        });
      }

      atRisk -= (events + censored);
    }


    // 验证最终结果
  const finalSurvival = survivalPoints[survivalPoints.length - 1]?.survival || 1.0;
  const finalAtRisk = atRisk;
  
  console.log('Final survival validation:', {
    expectedHasSurvivors: finalSurvivalCheck.hasFinalSurvivors,
    actualFinalSurvival: finalSurvival,
    finalAtRisk: finalAtRisk,
    isConsistent: (finalSurvival > 0) === finalSurvivalCheck.hasFinalSurvivors,
    reason: finalSurvivalCheck.reason
  });
  //////

    console.log('Survival points:', survivalPoints);

    return survivalPoints;
  };

  // main data processing effect
  useEffect(() => {
    if (!rawData?.data) return;

    console.log('Processing ARDaC survival data:', {
      outcomeType,
      groupingField,
      dataLength: rawData.data.length
    });

    // check data quality
    const quality = checkDataQuality(rawData.data);
    setDataQuality(quality);

    // prepare survival data
    const survivalPatients = prepareSurvivalData(rawData.data, outcomeType, groupingField);

    // group by group
    const groupedData = {};
    const counts = {};

    const groups = [...new Set(survivalPatients.map(p => p.group))];

    groups.forEach(group => {
      const groupPatients = survivalPatients.filter(p => p.group === group);
      counts[group] = groupPatients.length;

      if (groupPatients.length > 0) {
        groupedData[group] = calculateSurvivalData(groupPatients);
      }


    });

    console.log('Grouped data:', groupedData);

    setSurvivalData(groupedData);
    setPatientCounts(counts);

    console.log('ARDaC Survival Analysis Results:', {
      groups: Object.keys(groupedData),
      counts,
      dataQuality: quality
    });

  }, [rawData, outcomeType, groupingField]);

  // plot data
  const chartData = (() => {
    const timePoints = new Set();
    Object.values(survivalData).forEach(groupData => {
      groupData.forEach(point => timePoints.add(point.time));
    });

    const sortedTimes = Array.from(timePoints).sort((a, b) => a - b);
    return sortedTimes.map(time => {
      const point = { time };
      Object.entries(survivalData).forEach(([group, groupData]) => {
        let survivalPoint = groupData.find(p => p.time === time);
        if (!survivalPoint) {
          for (let i = groupData.length - 1; i >= 0; i--) {
            if (groupData[i].time < time) {
              survivalPoint = groupData[i];
              break;
            }
          }
        }
        point[`survival_${group}`] = survivalPoint ? survivalPoint.survival : 1.0;
      });
      return point;
    });
  })();

  return (
    <div className="w-full p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-semibold">ARDaC Kaplan-Meier Survival Analysis</h3>
        <div className="flex gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Outcome</label>
            <select
              value={outcomeType}
              onChange={(e) => setOutcomeType(e.target.value)}
              className="border rounded p-1 min-w-[200px]"
              disabled={fetchingRef.current}
            >
              {outcomeTypes.map(type => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Group By</label>
            <select
              value={groupingField}
              onChange={(e) => setGroupingField(e.target.value)}
              className="border rounded p-1 min-w-[150px]"
              disabled={fetchingRef.current}
            >
              {groupingFields.map(field => (
                <option key={field.value} value={field.value}>
                  {field.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* data quality report */}
      {dataQuality.warnings && dataQuality.warnings.length > 0 && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded">
          <div className="font-medium text-yellow-800 mb-1">Data Quality Warnings:</div>
          <ul className="text-sm text-yellow-700">
            {dataQuality.warnings.map((warning, index) => (
              <li key={index}>• {warning}</li>
            ))}
          </ul>
        </div>
      )}

      {/* patient count */}
      <div className="mb-4 p-2 bg-blue-50 border border-blue-200 rounded">
        <div className="font-medium mb-1">Patients per group:</div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
          {Object.entries(patientCounts).map(([group, count]) => (
            <div key={group} className="text-sm">
              {group}: {count} patients
            </div>
          ))}
        </div>
        {dataQuality.totalPatients && (
          <div className="mt-2 text-sm text-blue-600 space-y-1">
            <div>Total events: {outcomeType === 'death' ? dataQuality.deathEvents : dataQuality.akiEvents} / {dataQuality.totalPatients}</div>
            <div>Using max_days_to_follow_up_test for follow-up time</div>
          </div>
        )}
      </div>

      {/* survival curve */}
      <div className="w-full h-[400px]">
        {Object.keys(survivalData).length > 0 ? (
          <LineChart
            width={800}
            height={400}
            data={chartData}
            margin={{ top: 20, right: 30, left: 50, bottom: 70 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              type="number"
              label={{ value: 'Time (days)', position: 'bottom', offset: 40 }}
            />
            <YAxis
              domain={[0, 1]}
              label={{ value: 'Survival Probability', angle: -90, position: 'left' }}
            />
            <Tooltip
              formatter={(value, name) => [
                Number(value).toFixed(3),
                `Survival (${name.split('_')[1]})`
              ]}
              labelFormatter={(label) => `Time: ${label} days`}
            />
            <Legend
              formatter={(value) => value.split('_')[1]}
              verticalAlign="bottom"
              offset={20}
            />
            {Object.keys(survivalData).map((group, index) => (
              <Line
                key={group}
                type="stepAfter"
                dataKey={`survival_${group}`}
                stroke={COLORS[index % COLORS.length]}
                dot={false}
                name={`survival_${group}`}
              />
            ))}
          </LineChart>
        ) : (
          <div className="h-full flex items-center justify-center text-gray-500">
            {fetchingRef.current ? 'Loading ARDaC data...' : 'No survival data available for selected criteria'}
          </div>
        )}
      </div>
    </div>
  );
};

export default ARDaCSurvivalCurve;