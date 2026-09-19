package com.agras.fieldtracker;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PowerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
