// Recorded-shape fixture (hand-built from the Terra data-models page; not a live capture).
// https://docs.tryterra.co/reference/health-and-fitness-api/data-models.md
export const REFERENCE_ID = '7b1c2f0e-3a54-4a7e-9d1b-0f6c5a2e8d11';
export const TERRA_USER_ID = 'a1b2c3d4-0000-4000-8000-terrauser0001';

export const sleepPayload = {
  status: 'success',
  type: 'sleep',
  user: {
    user_id: TERRA_USER_ID,
    provider: 'ZEPP',
    reference_id: REFERENCE_ID,
    last_webhook_update: '2026-03-02T07:30:00.000000+00:00',
  },
  data: [
    {
      metadata: {
        start_time: '2026-03-01T23:10:00.000+01:00',
        end_time: '2026-03-02T06:50:00.000+01:00',
        timestamp_localization: 1,
      },
      scores: { sleep: 82 },
      heart_rate_data: { summary: { resting_hr_bpm: 51, avg_hrv_rmssd: 64.2, avg_hrv_sdnn: 70.1 } },
    },
    {
      // afternoon nap, same wake date: shorter -> must lose to the main session
      metadata: {
        start_time: '2026-03-02T14:00:00.000+01:00',
        end_time: '2026-03-02T14:30:00.000+01:00',
        timestamp_localization: 1,
      },
      scores: { sleep: 40 },
      heart_rate_data: { summary: { resting_hr_bpm: 60, avg_hrv_rmssd: 30 } },
    },
    {
      // next day, nulls/zeros = "no reading" -> only sleep_score survives
      metadata: {
        start_time: '2026-03-02T23:00:00.000+01:00',
        end_time: '2026-03-03T06:30:00.000+01:00',
        timestamp_localization: 1,
      },
      scores: { sleep: 77 },
      heart_rate_data: { summary: { resting_hr_bpm: 0, avg_hrv_rmssd: null } },
    },
  ],
};

export const dailyPayload = {
  status: 'success',
  type: 'daily',
  user: sleepPayload.user,
  data: [
    {
      metadata: {
        start_time: '2026-03-02T00:00:00.000+01:00',
        end_time: '2026-03-03T00:00:00.000+01:00',
      },
      heart_rate_data: { summary: { resting_hr_bpm: 55, avg_hrv_rmssd: 50 } },
    },
  ],
};
