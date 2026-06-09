// Forces each test file to use an in-memory DB unless it sets PULSE_DB.
process.env.PULSE_DB = process.env.PULSE_DB ?? ':memory:';
